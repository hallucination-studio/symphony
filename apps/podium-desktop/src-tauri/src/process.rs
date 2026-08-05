//! Local Conductor process ownership.
//!
//! A Conductor is one real operating-system process, but it is allowed to
//! start descendants (the Agent CLI and its helpers).  On Unix we put the
//! process in its own process group so that preemption cannot leave a child
//! behind.  The supervisor only reports a successful stop after the leader is
//! reaped and the whole process group has disappeared.

#[cfg(unix)]
use std::io;
use std::io::Read;
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CAPTURE_LIMIT: usize = 2 * 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Errors from process creation, observation, and bounded shutdown.
///
/// The variants intentionally do not carry OS error text.  Callers can show
/// these values to the operator without accidentally exposing command-line or
/// environment details from a child process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessError {
    SpawnFailed,
    WaitFailed,
    SignalFailed,
    ProcessTreeStillRunning,
    ProcessTreeUnsupported,
    OutputCaptureFailed,
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::SpawnFailed => "process_start_failed",
            Self::WaitFailed => "process_wait_failed",
            Self::SignalFailed => "process_signal_failed",
            Self::ProcessTreeStillRunning => "process_tree_still_running",
            Self::ProcessTreeUnsupported => "process_tree_unsupported",
            Self::OutputCaptureFailed => "process_output_capture_failed",
        };
        formatter.write_str(reason)
    }
}

impl std::error::Error for ProcessError {}

#[derive(Debug, Default)]
struct OutputCapture {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn capture_stdout(mut stdout: impl Read, output: Arc<Mutex<OutputCapture>>) {
    let mut buffer = [0_u8; 8192];
    loop {
        let read = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let Ok(mut captured) = output.lock() else {
            break;
        };
        let remaining = CAPTURE_LIMIT.saturating_sub(captured.bytes.len());
        if remaining > 0 {
            captured.bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        if read > remaining {
            captured.overflowed = true;
        }
    }
}

/// Output and exit information retained by the owning launch boundary.
///
/// This is `pub(crate)` so the launcher can parse the structured terminal
/// event, while callers only receive the sanitized `ConductorObservation`.
pub(crate) struct CapturedProcess {
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
}

pub struct ManagedProcess {
    child: Child,
    output: Arc<Mutex<OutputCapture>>,
    output_thread: Option<JoinHandle<()>>,
    reaped_status: Option<ExitStatus>,
    #[cfg(unix)]
    process_group_id: i32,
}

impl std::fmt::Debug for ManagedProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = formatter.debug_struct("ManagedProcess");
        debug.field("pid", &self.child.id());
        #[cfg(unix)]
        debug.field("process_group_id", &self.process_group_id);
        debug.field("reaped", &self.reaped_status.is_some());
        debug.finish()
    }
}

impl ManagedProcess {
    /// Spawn one process and put it in an isolated process group on Unix.
    pub fn spawn(mut command: Command) -> Result<Self, ProcessError> {
        #[cfg(not(unix))]
        {
            let _ = command;
            return Err(ProcessError::ProcessTreeUnsupported);
        }

        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                // A child that calls setpgid(0, 0) becomes the leader of a new
                // group.  All descendants inherit that group by default.
                if libc::setpgid(0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|_| ProcessError::SpawnFailed)?;
        let output = Arc::new(Mutex::new(OutputCapture::default()));
        let output_thread = child.stdout.take().map(|stdout| {
            let output = Arc::clone(&output);
            thread::spawn(move || capture_stdout(stdout, output))
        });

        #[cfg(unix)]
        let process_group_id = child.id().try_into().map_err(|_| ProcessError::SpawnFailed)?;

        Ok(Self {
            child,
            output,
            output_thread,
            reaped_status: None,
            #[cfg(unix)]
            process_group_id,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    #[cfg(unix)]
    pub fn process_group_id(&self) -> i32 {
        self.process_group_id
    }

    fn reap_if_exited(&mut self) -> Result<Option<ExitStatus>, ProcessError> {
        if self.reaped_status.is_some() {
            return Ok(self.reaped_status);
        }
        let status = self.child.try_wait().map_err(|_| ProcessError::WaitFailed)?;
        if status.is_some() {
            self.reaped_status = status;
        }
        Ok(status)
    }

    fn reap(&mut self) -> Result<ExitStatus, ProcessError> {
        if let Some(status) = self.reaped_status {
            return Ok(status);
        }
        let status = self.child.wait().map_err(|_| ProcessError::WaitFailed)?;
        self.reaped_status = Some(status);
        Ok(status)
    }

    fn join_output(&mut self) -> Result<Vec<u8>, ProcessError> {
        if let Some(thread) = self.output_thread.take() {
            thread.join().map_err(|_| ProcessError::OutputCaptureFailed)?;
        }
        let captured = self.output.lock().map_err(|_| ProcessError::OutputCaptureFailed)?;
        if captured.overflowed {
            return Err(ProcessError::OutputCaptureFailed);
        }
        Ok(captured.bytes.clone())
    }

    fn complete(&mut self, status: ExitStatus) -> Result<CapturedProcess, ProcessError> {
        self.reaped_status = Some(status);
        let stdout = self.join_output()?;
        Ok(CapturedProcess { exit_code: status.code(), stdout })
    }

    pub(crate) fn wait_and_capture(&mut self) -> Result<CapturedProcess, ProcessError> {
        #[cfg(not(unix))]
        {
            return Err(ProcessError::ProcessTreeUnsupported);
        }
        let status = self.reap()?;
        #[cfg(unix)]
        if process_group_exists(self.process_group_id)? {
            return Err(ProcessError::ProcessTreeStillRunning);
        }
        self.complete(status)
    }

    pub(crate) fn try_capture_if_exited(
        &mut self,
    ) -> Result<Option<CapturedProcess>, ProcessError> {
        #[cfg(not(unix))]
        {
            return Err(ProcessError::ProcessTreeUnsupported);
        }
        let Some(status) = self.reap_if_exited()? else {
            return Ok(None);
        };
        #[cfg(unix)]
        if process_group_exists(self.process_group_id)? {
            return Err(ProcessError::ProcessTreeStillRunning);
        }
        self.complete(status).map(Some)
    }

    /// Wait for the leader and report its exit code, requiring a dead process
    /// group as well.  This prevents a natural leader exit from being mistaken
    /// for a stopped Conductor tree.
    pub fn observed_exit(&mut self) -> Result<Option<i32>, ProcessError> {
        let captured = self.wait_and_capture()?;
        Ok(captured.exit_code)
    }

    /// Non-blocking equivalent of [`Self::observed_exit`].
    pub fn try_observed_exit(&mut self) -> Result<Option<Option<i32>>, ProcessError> {
        Ok(self.try_capture_if_exited()?.map(|captured| captured.exit_code))
    }

    /// Send TERM to the complete process group, wait for the bounded grace
    /// period, then send KILL and wait again.  The method returns only after
    /// the child has been reaped and the process group is confirmed gone.
    pub fn stop_within(&mut self, grace: Duration) -> Result<Option<i32>, ProcessError> {
        Ok(self.stop_and_capture(grace)?.exit_code)
    }

    pub(crate) fn stop_and_capture(
        &mut self,
        grace: Duration,
    ) -> Result<CapturedProcess, ProcessError> {
        #[cfg(not(unix))]
        {
            let _ = grace;
            return Err(ProcessError::ProcessTreeUnsupported);
        }
        #[cfg(unix)]
        signal_group(self.process_group_id, libc::SIGTERM)?;

        if let Some(captured) = self.wait_for_tree(grace)? {
            return Ok(captured);
        }

        #[cfg(unix)]
        signal_group(self.process_group_id, libc::SIGKILL)?;

        let kill_grace = grace.max(Duration::from_millis(100));
        if let Some(captured) = self.wait_for_tree(kill_grace)? {
            return Ok(captured);
        }
        Err(ProcessError::ProcessTreeStillRunning)
    }

    /// Compatibility spelling used by the former desktop process owner.
    pub fn shutdown_within(&mut self, duration: Duration) -> Result<Option<i32>, ProcessError> {
        self.stop_within(duration)
    }

    fn wait_for_tree(
        &mut self,
        duration: Duration,
    ) -> Result<Option<CapturedProcess>, ProcessError> {
        let deadline = Instant::now() + duration;
        loop {
            let status = self.reap_if_exited()?;
            #[cfg(unix)]
            let tree_gone = !process_group_exists(self.process_group_id)?;
            #[cfg(not(unix))]
            let tree_gone = status.is_some();
            if tree_gone {
                // `try_wait` already reaps the leader.  Joining the capture
                // thread here also proves all inherited stdout handles closed.
                if let Some(status) = status {
                    let stdout = self.join_output()?;
                    return Ok(Some(CapturedProcess { exit_code: status.code(), stdout }));
                }
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        // Dropping is not the scheduler's stop confirmation, but it must not
        // strand descendants either.  Keep this cleanup short and best
        // effort; callers that need a hard guarantee use `stop_within` and
        // propagate its error instead of relying on Drop.
        #[cfg(unix)]
        {
            if process_group_exists(self.process_group_id).unwrap_or(true) {
                let _ = signal_group(self.process_group_id, libc::SIGTERM);
                let term_deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < term_deadline {
                    let _ = self.reap_if_exited();
                    if !process_group_exists(self.process_group_id).unwrap_or(true) {
                        break;
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            }
            if process_group_exists(self.process_group_id).unwrap_or(true) {
                let _ = signal_group(self.process_group_id, libc::SIGKILL);
                let kill_deadline = Instant::now() + Duration::from_millis(100);
                while Instant::now() < kill_deadline {
                    let _ = self.reap_if_exited();
                    if !process_group_exists(self.process_group_id).unwrap_or(true) {
                        break;
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            }
            if self.reaped_status.is_none() {
                let _ = self.child.wait();
            }
        }
        #[cfg(not(unix))]
        {
            if self.reaped_status.is_none() {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

#[cfg(unix)]
fn signal_group(process_group_id: i32, signal: i32) -> Result<(), ProcessError> {
    let result = unsafe { libc::killpg(process_group_id, signal) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(ProcessError::SignalFailed);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_group_exists(process_group_id: i32) -> Result<bool, ProcessError> {
    let result = unsafe { libc::killpg(process_group_id, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(ProcessError::SignalFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::Stdio;

    #[cfg(unix)]
    #[test]
    fn bounded_stop_reaps_the_complete_process_group() {
        let mut command = Command::new("sh");
        command.args(["-c", "trap '' TERM; sleep 30 & wait"]);
        command.stdout(Stdio::null());
        let mut process = ManagedProcess::spawn(command).expect("fixture should start");
        let process_group_id = process.process_group_id();

        process
            .stop_within(Duration::from_millis(50))
            .expect("KILL should finish the fixture tree");

        assert_eq!(unsafe { libc::killpg(process_group_id, 0) }, -1);
        assert!(process.reaped_status.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn natural_exit_is_waited_and_reaped() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf '{\"event\":\"conductor_stopped\"}\\n'"]);
        command.stdout(Stdio::piped());
        let mut process = ManagedProcess::spawn(command).expect("fixture should start");
        let output = process.wait_and_capture().expect("fixture should exit");

        assert_eq!(output.exit_code, Some(0));
        assert!(String::from_utf8_lossy(&output.stdout).contains("conductor_stopped"));
    }

    #[cfg(unix)]
    #[test]
    fn a_natural_leader_exit_does_not_confirm_a_live_descendant() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 &"]);
        command.stdout(Stdio::null());
        let mut process = ManagedProcess::spawn(command).expect("fixture should start");

        assert_eq!(process.observed_exit(), Err(ProcessError::ProcessTreeStillRunning));
        process.stop_within(Duration::from_millis(50)).expect("fixture tree should be killable");
    }

    #[cfg(not(unix))]
    #[test]
    fn process_tree_operations_are_explicitly_unsupported_without_process_groups() {
        let error = ManagedProcess::spawn(Command::new("conductor")).unwrap_err();
        assert_eq!(error, ProcessError::ProcessTreeUnsupported);
    }
}
