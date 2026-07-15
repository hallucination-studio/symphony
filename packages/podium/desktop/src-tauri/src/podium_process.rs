use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const FRAME_LIMIT: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct PodiumProcess {
    child: Child,
    responses: Receiver<Result<serde_json::Value, String>>,
}

impl PodiumProcess {
    pub fn start() -> Result<Self, String> {
        let mut child = Command::new(sidecar_path()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("podium_sidecar_spawn_failed:{error}"))?;
        let responses = response_reader(&mut child)?;
        let mut process = Self { child, responses };
        let handshake = write_request(&mut process.child, "handshake", "desktop-start")
            .and_then(|_| process.read_response(HANDSHAKE_TIMEOUT))
            .and_then(|response| {
                validate_response(&response, "handshake.result", "desktop-start", "ready")
            });
        if let Err(error) = handshake {
            process.stop();
            return Err(error);
        }
        Ok(process)
    }

    pub fn shutdown(&mut self) {
        if write_request(&mut self.child, "shutdown", "desktop-stop").is_ok()
            && self
                .read_response(HANDSHAKE_TIMEOUT)
                .and_then(|response| {
                    validate_response(&response, "shutdown.result", "desktop-stop", "stopping")
                })
                .is_ok()
        {
            let _ = self.child.wait();
            return;
        }
        self.stop();
    }

    pub fn exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|error| format!("podium_sidecar_status_failed:{error}"))
    }

    fn read_response(&self, timeout: Duration) -> Result<serde_json::Value, String> {
        self.responses
            .recv_timeout(timeout)
            .map_err(|_| "podium_sidecar_response_timeout".to_string())?
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for PodiumProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.stop();
        }
    }
}

fn sidecar_path() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("podium-{}", env!("TAURI_ENV_TARGET_TRIPLE"))));
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("podium_desktop_executable_unavailable:{error}"))?;
    Ok(executable.parent().ok_or("podium_desktop_executable_parent_missing")?.join("podium"))
}

fn write_request(child: &mut Child, kind: &str, request_id: &str) -> Result<(), String> {
    let body =
        format!("{{\"kind\":\"{kind}\",\"request_id\":\"{request_id}\",\"protocol_version\":1}}");
    let stdin = child.stdin.as_mut().ok_or("podium_sidecar_stdin_missing")?;
    stdin
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|_| stdin.write_all(body.as_bytes()))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("podium_sidecar_write_failed:{error}"))
}

fn response_reader(
    child: &mut Child,
) -> Result<Receiver<Result<serde_json::Value, String>>, String> {
    let mut stdout = child.stdout.take().ok_or("podium_sidecar_stdout_missing")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || loop {
        let result = read_frame(&mut stdout);
        let stopping = result.is_err();
        if sender.send(result).is_err() || stopping {
            return;
        }
    });
    Ok(receiver)
}

fn read_frame(reader: &mut impl Read) -> Result<serde_json::Value, String> {
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|error| format!("podium_sidecar_read_failed:{error}"))?;
    let size = u32::from_be_bytes(header) as usize;
    if size > FRAME_LIMIT {
        return Err("podium_sidecar_frame_too_large".into());
    }
    let mut body = vec![0; size];
    reader.read_exact(&mut body).map_err(|error| format!("podium_sidecar_read_failed:{error}"))?;
    serde_json::from_slice(&body).map_err(|error| format!("podium_sidecar_json_invalid:{error}"))
}

fn validate_response(
    response: &serde_json::Value,
    kind: &str,
    request_id: &str,
    status: &str,
) -> Result<(), String> {
    let expected = serde_json::json!({
        "kind": kind,
        "request_id": request_id,
        "protocol_version": 1,
        "status": status,
    });
    if response == &expected {
        Ok(())
    } else {
        Err("podium_sidecar_response_invalid".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_a_bounded_json_frame() {
        let body = br#"{"kind":"health.result"}"#;
        let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(body);

        assert_eq!(
            read_frame(&mut Cursor::new(bytes)).unwrap(),
            serde_json::json!({"kind": "health.result"})
        );
    }

    #[test]
    fn rejects_an_oversized_frame_before_reading_its_body() {
        let bytes = ((FRAME_LIMIT + 1) as u32).to_be_bytes();

        assert_eq!(
            read_frame(&mut Cursor::new(bytes)).unwrap_err(),
            "podium_sidecar_frame_too_large"
        );
    }

    #[test]
    fn response_validation_is_exact() {
        let response = serde_json::json!({
            "kind": "handshake.result",
            "request_id": "desktop-start",
            "protocol_version": 1,
            "status": "ready",
            "unexpected": true,
        });

        assert_eq!(
            validate_response(&response, "handshake.result", "desktop-start", "ready").unwrap_err(),
            "podium_sidecar_response_invalid"
        );
    }

    #[test]
    fn response_timeout_is_bounded() {
        let (_sender, receiver) = mpsc::channel::<Result<serde_json::Value, String>>();
        let started = std::time::Instant::now();

        assert!(receiver.recv_timeout(Duration::from_millis(10)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
