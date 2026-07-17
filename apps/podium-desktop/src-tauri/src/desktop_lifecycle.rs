#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, PartialEq, Eq)]
pub enum ProcessError {
    SpawnFailed,
    SignalFailed,
    WaitFailed,
    ProcessTreeStillRunning,
}

pub struct ManagedProcess {
    child: Child,
    #[cfg(unix)]
    process_group_id: i32,
}

impl ManagedProcess {
    pub fn spawn(mut command: Command) -> Result<Self, ProcessError> {
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(|_| ProcessError::SpawnFailed)?;
        #[cfg(unix)]
        let process_group_id = child.id() as i32;
        Ok(Self {
            child,
            #[cfg(unix)]
            process_group_id,
        })
    }

    pub fn observed_exit(&mut self) -> Result<Option<i32>, ProcessError> {
        let status = self.child.wait().map_err(|_| ProcessError::WaitFailed)?;
        #[cfg(unix)]
        if process_group_exists(self.process_group_id)? {
            return Err(ProcessError::ProcessTreeStillRunning);
        }
        Ok(status.code())
    }

    pub fn try_observed_exit(&mut self) -> Result<Option<Option<i32>>, ProcessError> {
        let Some(status) = self.child.try_wait().map_err(|_| ProcessError::WaitFailed)? else {
            return Ok(None);
        };
        #[cfg(unix)]
        if process_group_exists(self.process_group_id)? {
            return Err(ProcessError::ProcessTreeStillRunning);
        }
        Ok(Some(status.code()))
    }

    pub async fn shutdown_by(&mut self, deadline: Instant) -> Result<Option<i32>, ProcessError> {
        #[cfg(unix)]
        signal_group(self.process_group_id, libc::SIGTERM)?;
        #[cfg(not(unix))]
        self.child.kill().map_err(|_| ProcessError::SignalFailed)?;

        let mut exit_code = None;
        while Instant::now() < deadline {
            if exit_code.is_none() {
                exit_code = self
                    .child
                    .try_wait()
                    .map_err(|_| ProcessError::WaitFailed)?
                    .map(|status| status.code());
            }
            #[cfg(unix)]
            if exit_code.is_some() && !process_group_exists(self.process_group_id)? {
                return Ok(exit_code.flatten());
            }
            #[cfg(not(unix))]
            if exit_code.is_some() {
                return Ok(exit_code.flatten());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        #[cfg(unix)]
        signal_group(self.process_group_id, libc::SIGKILL)?;
        #[cfg(not(unix))]
        self.child.kill().map_err(|_| ProcessError::SignalFailed)?;
        let forced_deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if exit_code.is_none() {
                exit_code = self
                    .child
                    .try_wait()
                    .map_err(|_| ProcessError::WaitFailed)?
                    .map(|status| status.code());
            }
            #[cfg(unix)]
            let tree_exited = !process_group_exists(self.process_group_id)?;
            #[cfg(not(unix))]
            let tree_exited = exit_code.is_some();
            if exit_code.is_some() && tree_exited {
                return Ok(exit_code.flatten());
            }
            if Instant::now() >= forced_deadline {
                return Err(ProcessError::ProcessTreeStillRunning);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn shutdown_within(
        &mut self,
        duration: Duration,
    ) -> Result<Option<i32>, ProcessError> {
        self.shutdown_by(Instant::now() + duration).await
    }
}

#[cfg(unix)]
fn signal_group(process_group_id: i32, signal: i32) -> Result<(), ProcessError> {
    let result = unsafe { libc::killpg(process_group_id, signal) };
    if result == -1 {
        let error = std::io::Error::last_os_error();
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
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(ProcessError::SignalFailed),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn bounded_shutdown_terminates_and_reaps_the_process_group() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut command = Command::new("sh");
            command.args(["-c", "trap '' TERM; sleep 30 & wait"]);
            let mut process = ManagedProcess::spawn(command).unwrap();

            let result = process.shutdown_within(Duration::from_millis(100)).await;

            assert!(result.is_ok());
            assert_eq!(
                unsafe { libc::killpg(process.process_group_id, 0) },
                -1,
                "the complete process group must be gone"
            );
        });
    }

    #[test]
    fn natural_exit_is_observed_and_reaped() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 7"]);
            let mut process = ManagedProcess::spawn(command).unwrap();

            assert_eq!(process.observed_exit().unwrap(), Some(7));
        });
    }

    #[test]
    fn controller_exit_does_not_confirm_a_live_descendant_tree() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30 &"]);
            let mut process = ManagedProcess::spawn(command).unwrap();

            assert_eq!(process.observed_exit(), Err(ProcessError::ProcessTreeStillRunning));
            assert!(process.shutdown_within(Duration::from_millis(100)).await.is_ok());
        });
    }
}
