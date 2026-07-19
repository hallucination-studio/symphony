#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub enum PrivateIpcError {
    InvalidInstanceId,
    CreateFailed,
}

#[cfg(unix)]
#[derive(Debug)]
pub struct PrivateIpc {
    instance_id: String,
    parent: UnixStream,
    child: OwnedFd,
}

#[cfg(unix)]
#[derive(Debug)]
pub struct ParentPrivateIpc {
    instance_id: String,
    stream: UnixStream,
}

#[cfg(unix)]
impl PrivateIpc {
    pub fn create(instance_id: &str) -> Result<Self, PrivateIpcError> {
        if instance_id.is_empty() {
            return Err(PrivateIpcError::InvalidInstanceId);
        }
        let (parent, child) = UnixStream::pair().map_err(|_| PrivateIpcError::CreateFailed)?;
        Ok(Self { instance_id: instance_id.to_owned(), parent, child: child.into() })
    }

    pub fn child_fd(&self) -> i32 {
        self.child.as_raw_fd()
    }

    pub fn configure_child(self, command: &mut Command) -> ParentPrivateIpc {
        let child_fd = self.child_fd();
        command.env("SYMPHONY_PRIVATE_IPC_FD", child_fd.to_string());
        command.env("SYMPHONY_INSTANCE_ID", &self.instance_id);
        let child = self.child;
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(move || {
                if libc::fcntl(child_fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                let _keep_open_until_exec = &child;
                Ok(())
            });
        }
        ParentPrivateIpc { instance_id: self.instance_id, stream: self.parent }
    }
}

#[cfg(unix)]
impl ParentPrivateIpc {
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn stream(&self) -> &UnixStream {
        &self.stream
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn creates_unique_unnamed_inherited_channels() {
        let first = PrivateIpc::create("instance-1").unwrap();
        let second = PrivateIpc::create("instance-2").unwrap();

        assert_ne!(first.child_fd(), second.child_fd());
        assert!(first.child_fd() >= 0);
        let mut first_command = Command::new("true");
        let mut second_command = Command::new("true");
        let first_parent = first.configure_child(&mut first_command);
        let second_parent = second.configure_child(&mut second_command);
        assert_ne!(first_parent.instance_id(), second_parent.instance_id());
        assert!(first_parent.stream().as_raw_fd() >= 0);
    }

    #[test]
    fn rejects_an_empty_instance_identity() {
        assert_eq!(PrivateIpc::create("").unwrap_err(), PrivateIpcError::InvalidInstanceId);
    }

    #[test]
    fn child_receives_only_the_inherited_descriptor_and_instance_identity() {
        let ipc = PrivateIpc::create("instance-1").unwrap();
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "test -e /dev/fd/$SYMPHONY_PRIVATE_IPC_FD && test \"$SYMPHONY_INSTANCE_ID\" = instance-1",
        ]);
        let _parent = ipc.configure_child(&mut command);

        assert!(command.status().unwrap().success());
    }
}
