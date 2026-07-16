#[cfg(unix)]
use serde_json::Value;
#[cfg(unix)]
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::mem;
#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
const MAX_HANDOFF_BYTES: usize = 4 * 1024;

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

#[cfg(unix)]
pub struct DynamicSessionHandoff {
    channel: UnixStream,
}

#[cfg(unix)]
impl DynamicSessionHandoff {
    pub fn new(channel: UnixStream) -> Self {
        Self { channel }
    }

    pub fn transfer(&mut self, endpoint: OwnedFd, metadata: &Value) -> Result<Value, &'static str> {
        let body = serde_json::to_vec(metadata).map_err(|_| "session_handoff_json_invalid")?;
        if body.len() > MAX_HANDOFF_BYTES {
            return Err("session_handoff_frame_too_large");
        }
        let mut frame = Vec::with_capacity(body.len() + 4);
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        send_descriptor(&self.channel, endpoint.as_raw_fd(), &frame)?;
        drop(endpoint);
        read_result(&mut self.channel)
    }
}

#[cfg(unix)]
fn send_descriptor(
    channel: &UnixStream,
    descriptor: RawFd,
    frame: &[u8],
) -> Result<(), &'static str> {
    let mut iovec =
        libc::iovec { iov_base: frame.as_ptr().cast_mut().cast(), iov_len: frame.len() };
    let control_len = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) as usize };
    let mut control = vec![0_u8; control_len];
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len() as _;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null() {
            return Err("session_handoff_descriptor_invalid");
        }
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<RawFd>() as u32) as _;
        *(libc::CMSG_DATA(header).cast::<RawFd>()) = descriptor;
        let sent = libc::sendmsg(channel.as_raw_fd(), &message, 0);
        if sent <= 0 {
            return Err("session_handoff_send_failed");
        }
        if sent as usize != frame.len() {
            (&*channel)
                .write_all(&frame[sent as usize..])
                .map_err(|_| "session_handoff_send_failed")?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn read_result(channel: &mut UnixStream) -> Result<Value, &'static str> {
    let mut header = [0_u8; 4];
    channel.read_exact(&mut header).map_err(|_| "session_handoff_response_failed")?;
    let size = u32::from_be_bytes(header) as usize;
    if size > MAX_HANDOFF_BYTES {
        return Err("session_handoff_response_too_large");
    }
    let mut body = vec![0_u8; size];
    channel.read_exact(&mut body).map_err(|_| "session_handoff_response_failed")?;
    serde_json::from_slice(&body).map_err(|_| "session_handoff_response_invalid")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::FromRawFd;
    use std::thread;

    #[test]
    fn carries_opaque_bytes_over_an_inheritable_private_pair() {
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

    #[test]
    fn transfers_one_endpoint_and_reads_the_bounded_result() {
        let (desktop, mut podium) = UnixStream::pair().unwrap();
        let (mut endpoint, transferred) = inherited_channel().unwrap();
        let receiver = thread::spawn(move || {
            let mut bytes = [0_u8; 256];
            let mut iovec =
                libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
            let control_len = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) as usize };
            let mut control = vec![0_u8; control_len];
            let mut message: libc::msghdr = unsafe { mem::zeroed() };
            message.msg_iov = &mut iovec;
            message.msg_iovlen = 1;
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = control.len() as _;
            let received = unsafe { libc::recvmsg(podium.as_raw_fd(), &mut message, 0) };
            assert!(received > 4);
            let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
            assert!(!header.is_null());
            assert_eq!(unsafe { (*header).cmsg_level }, libc::SOL_SOCKET);
            assert_eq!(unsafe { (*header).cmsg_type }, libc::SCM_RIGHTS);
            let descriptor = unsafe { *(libc::CMSG_DATA(header).cast::<RawFd>()) };
            let mut adopted = unsafe { UnixStream::from_raw_fd(descriptor) };
            adopted.write_all(b"session-ready").unwrap();

            let result = serde_json::to_vec(&serde_json::json!({"status": "accepted"})).unwrap();
            podium.write_all(&(result.len() as u32).to_be_bytes()).unwrap();
            podium.write_all(&result).unwrap();
        });

        let mut handoff = DynamicSessionHandoff::new(desktop);
        assert_eq!(
            handoff.transfer(transferred, &serde_json::json!({"session_id": "session-1"})).unwrap(),
            serde_json::json!({"status": "accepted"})
        );
        let mut proof = [0_u8; 13];
        endpoint.read_exact(&mut proof).unwrap();
        assert_eq!(&proof, b"session-ready");
        receiver.join().unwrap();
    }

    #[test]
    fn rejects_an_oversized_handoff_before_transferring_the_endpoint() {
        let (desktop, _podium) = UnixStream::pair().unwrap();
        let (_endpoint, transferred) = inherited_channel().unwrap();
        let mut handoff = DynamicSessionHandoff::new(desktop);

        assert_eq!(
            handoff
                .transfer(transferred, &serde_json::json!({"value": "x".repeat(MAX_HANDOFF_BYTES)}))
                .unwrap_err(),
            "session_handoff_frame_too_large"
        );
    }
}
