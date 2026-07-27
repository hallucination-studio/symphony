#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub enum BindingProcessFenceError {
    InvalidBindingId,
    RuntimeDirectoryUnavailable,
    LockFileUnavailable,
    AlreadyHeld,
    ConfigureChildFailed,
}

#[cfg(unix)]
#[derive(Debug)]
pub struct BindingProcessFence {
    file: File,
}

#[cfg(unix)]
impl BindingProcessFence {
    pub fn acquire(
        runtime_root: &Path,
        binding_id: &str,
    ) -> Result<Self, BindingProcessFenceError> {
        if binding_id.is_empty() || binding_id.len() > 128 {
            return Err(BindingProcessFenceError::InvalidBindingId);
        }
        let lock_root = runtime_root.join("binding-fences");
        fs::create_dir_all(&lock_root)
            .map_err(|_| BindingProcessFenceError::RuntimeDirectoryUnavailable)?;
        let digest = hex::encode(Sha256::digest(binding_id.as_bytes()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_root.join(format!("{digest}.lock")))
            .map_err(|_| BindingProcessFenceError::LockFileUnavailable)?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err(BindingProcessFenceError::AlreadyHeld);
        }
        Ok(Self { file })
    }

    pub fn configure_child(&self, command: &mut Command) -> Result<(), BindingProcessFenceError> {
        let fd = self.file.as_raw_fd();
        if fd < 0 {
            return Err(BindingProcessFenceError::ConfigureChildFailed);
        }
        command.env("SYMPHONY_BINDING_FENCE_FD", fd.to_string());
        inherit_fd(command, fd);
        Ok(())
    }
}

#[cfg(unix)]
fn inherit_fd(command: &mut Command, fd: RawFd) {
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::BindingProcessFence;
    use std::fs;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn runtime_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "symphony-binding-fence-{name}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        ))
    }

    #[test]
    fn rejects_a_second_live_host_for_the_same_binding() {
        let root = runtime_root("exclusive");
        let _first = BindingProcessFence::acquire(&root, "binding-1").unwrap();

        assert!(BindingProcessFence::acquire(&root, "binding-1").is_err());
        assert!(BindingProcessFence::acquire(&root, "binding-2").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherited_child_handle_fences_replacement_after_host_release() {
        let root = runtime_root("inherited");
        let fence = BindingProcessFence::acquire(&root, "binding-1").unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 0.2"]);
        fence.configure_child(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        drop(fence);

        assert!(BindingProcessFence::acquire(&root, "binding-1").is_err());
        assert!(child.wait().unwrap().success());
        assert!(BindingProcessFence::acquire(&root, "binding-1").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
