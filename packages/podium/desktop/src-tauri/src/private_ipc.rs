#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
pub fn inherited_channel() -> io::Result<(UnixStream, OwnedFd)> {
    let (parent, child) = UnixStream::pair()?;
    let child: OwnedFd = child.into();
    let flags = unsafe { libc::fcntl(child.as_raw_fd(), libc::F_GETFD) };
    if flags < 0
        || unsafe { libc::fcntl(child.as_raw_fd(), libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((parent, child))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn relays_opaque_bytes_over_an_inheritable_private_pair() {
        let (mut parent, child) = inherited_channel().unwrap();
        assert_eq!(unsafe { libc::fcntl(child.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
        let mut child = UnixStream::from(child);
        child.write_all(b"opaque-frame").unwrap();
        let mut received = [0; 12];
        parent.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"opaque-frame");
    }

    #[test]
    fn creates_an_isolated_pair_for_each_session() {
        let (first, _) = inherited_channel().unwrap();
        let (second, _) = inherited_channel().unwrap();
        assert_ne!(first.as_raw_fd(), second.as_raw_fd());
    }
}
