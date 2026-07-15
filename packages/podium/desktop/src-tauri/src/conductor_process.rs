use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Owns one explicitly configured Conductor child process.
///
/// Constructing this supervisor does not start a Conductor. The desktop must
/// only call `start` after a project binding supplies its isolated data root.
pub struct ConductorProcess {
    child: Child,
}

impl ConductorProcess {
    pub fn start(data_root: &Path) -> Result<Self, String> {
        Self::start_command(&conductor_path()?, data_root)
    }

    fn start_command(executable: &Path, data_root: &Path) -> Result<Self, String> {
        let child = Command::new(executable)
            .arg("--data-root")
            .arg(data_root)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("conductor_spawn_failed:{error}"))?;
        Ok(Self { child })
    }

    pub fn exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|error| format!("conductor_status_failed:{error}"))
    }

    pub fn shutdown(&mut self) {
        if let Err(error_code) = self.shutdown_checked() {
            eprintln!(
                "event=conductor_process_shutdown_failed error_type=process_lifecycle \
                 error_code={error_code} sanitized_reason={error_code} action_required=true \
                 retryable=false next_action=inspect_desktop_runtime"
            );
        }
    }

    pub fn shutdown_checked(&mut self) -> Result<(), &'static str> {
        if self.exited().map_err(|_| "conductor_status_failed")? {
            return Ok(());
        }
        terminate(&mut self.child)?;
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(STOP_POLL_INTERVAL),
                Err(_) => return Err("conductor_status_failed"),
            }
        }
        self.stop()
    }

    fn stop(&mut self) -> Result<(), &'static str> {
        if self.child.try_wait().map_err(|_| "conductor_status_failed")?.is_some() {
            return Ok(());
        }
        self.child.kill().map_err(|_| "conductor_kill_failed")?;
        self.child.wait().map_err(|_| "conductor_reap_failed")?;
        Ok(())
    }
}

impl Drop for ConductorProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.shutdown();
        }
    }
}

fn conductor_path() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("conductor-{}", env!("TAURI_ENV_TARGET_TRIPLE"))));
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("podium_desktop_executable_unavailable:{error}"))?;
    sibling_path(&executable)
}

fn sibling_path(desktop_executable: &Path) -> Result<PathBuf, String> {
    Ok(desktop_executable
        .parent()
        .ok_or("podium_desktop_executable_parent_missing")?
        .join("conductor"))
}

#[cfg(unix)]
fn terminate(child: &mut Child) -> Result<(), &'static str> {
    // SAFETY: `child.id()` is the live child owned by this supervisor and
    // `SIGTERM` does not borrow memory across the FFI boundary.
    unsafe {
        if libc::kill(child.id() as libc::pid_t, libc::SIGTERM) != 0 {
            return Err("conductor_terminate_failed");
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate(child: &mut Child) -> Result<(), &'static str> {
    child.kill().map_err(|_| "conductor_terminate_failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_conductor_next_to_the_installed_desktop() {
        assert_eq!(
            sibling_path(Path::new("/Applications/Symphony.app/Contents/MacOS/podium-desktop"))
                .unwrap(),
            PathBuf::from("/Applications/Symphony.app/Contents/MacOS/conductor")
        );
    }

    #[cfg(unix)]
    #[test]
    fn passes_the_isolated_data_root_and_reaps_the_child() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "symphony-conductor-supervisor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("conductor");
        let arguments = root.join("arguments");
        let stopped = root.join("stopped");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\ntrap \"touch '{}'; exit 0\" TERM\nprintf '%s\\n' \"$@\" > '{}'\nwhile :; do sleep 1; done\n",
                stopped.display(),
                arguments.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let data_root = root.join("bound-project");

        let mut process = ConductorProcess::start_command(&executable, &data_root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !arguments.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read_to_string(&arguments).unwrap(),
            format!("--data-root\n{}\n", data_root.display())
        );

        process.shutdown();
        assert!(process.exited().unwrap());
        assert!(stopped.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
