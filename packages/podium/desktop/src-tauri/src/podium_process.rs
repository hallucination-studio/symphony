use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

#[cfg(unix)]
use crate::private_ipc::{inherited_channel, DynamicSessionHandoff};

const FRAME_LIMIT: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct PodiumProcess {
    child: Child,
    responses: Receiver<Result<serde_json::Value, String>>,
    #[cfg(unix)]
    _session_handoff: DynamicSessionHandoff,
}

impl PodiumProcess {
    pub fn start() -> Result<Self, String> {
        Self::start_platform()
    }

    #[cfg(not(unix))]
    fn start_platform() -> Result<Self, String> {
        Err("podium_dynamic_session_handoff_unavailable".into())
    }

    #[cfg(unix)]
    fn start_platform() -> Result<Self, String> {
        let (broker, child_broker) =
            inherited_channel().map_err(|_| "podium_session_handoff_create_failed".to_string())?;
        let mut child = Command::new(sidecar_path()?)
            .arg("--desktop-ipc-fd")
            .arg(child_broker.as_raw_fd().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("podium_sidecar_spawn_failed:{error}"))?;
        drop(child_broker);
        let responses = response_reader(&mut child)?;
        let mut process =
            Self { child, responses, _session_handoff: DynamicSessionHandoff::new(broker) };
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

    pub(crate) fn command(
        &mut self,
        request: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        write_value(&mut self.child, request)?;
        self.read_response(HANDSHAKE_TIMEOUT)
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
    write_value(
        child,
        &serde_json::json!({
            "kind": kind,
            "request_id": request_id,
            "protocol_version": 1,
        }),
    )
}

fn write_value(child: &mut Child, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|_| "podium_sidecar_json_invalid")?;
    if body.len() > FRAME_LIMIT {
        return Err("podium_sidecar_frame_too_large".into());
    }
    let stdin = child.stdin.as_mut().ok_or("podium_sidecar_stdin_missing")?;
    stdin
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|_| stdin.write_all(&body))
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
    } else if let Some(observation) = lifecycle_failure(response, kind, request_id) {
        if observation.status == "degraded" {
            observation.log("podium_lifecycle_degraded");
            Ok(())
        } else {
            Err(observation.encode())
        }
    } else {
        Err("podium_sidecar_response_invalid".into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LifecycleObservation {
    pub(crate) status: String,
    pub(crate) error_code: String,
    pub(crate) sanitized_reason: String,
    pub(crate) action_required: bool,
    pub(crate) retryable: bool,
    pub(crate) next_action: String,
}

impl LifecycleObservation {
    fn encode(&self) -> String {
        format!(
            "podium_lifecycle_observed|{}|{}|{}|{}|{}|{}",
            self.status,
            self.error_code,
            self.sanitized_reason,
            self.action_required,
            self.retryable,
            self.next_action,
        )
    }

    pub(crate) fn log(&self, event: &str) {
        eprintln!(
            "event={event} error_type=lifecycle status={} error_code={} sanitized_reason={} \
             action_required={} retryable={} next_action={}",
            self.status,
            self.error_code,
            self.sanitized_reason,
            self.action_required,
            self.retryable,
            self.next_action,
        );
    }
}

fn lifecycle_failure(
    response: &serde_json::Value,
    kind: &str,
    request_id: &str,
) -> Option<LifecycleObservation> {
    let object = response.as_object()?;
    let expected_fields = [
        "kind",
        "request_id",
        "protocol_version",
        "status",
        "error_code",
        "sanitized_reason",
        "action_required",
        "retryable",
        "next_action",
    ];
    if object.len() != expected_fields.len()
        || expected_fields.iter().any(|field| !object.contains_key(*field))
        || object.get("kind")?.as_str()? != kind
        || object.get("request_id")?.as_str()? != request_id
        || object.get("protocol_version")?.as_u64()? != 1
        || !matches!(object.get("status")?.as_str()?, "failed" | "degraded")
    {
        return None;
    }
    let error_code = object.get("error_code")?.as_str()?;
    let reason = object.get("sanitized_reason")?.as_str()?;
    let next_action = object.get("next_action")?.as_str()?;
    if !safe_code(error_code, 128) || !safe_code(reason, 500) || !safe_code(next_action, 128) {
        return None;
    }
    Some(LifecycleObservation {
        status: object.get("status")?.as_str()?.to_owned(),
        error_code: error_code.to_owned(),
        sanitized_reason: reason.to_owned(),
        action_required: object.get("action_required")?.as_bool()?,
        retryable: object.get("retryable")?.as_bool()?,
        next_action: next_action.to_owned(),
    })
}

pub(crate) fn observed_lifecycle_failure(error: String) -> Option<LifecycleObservation> {
    let mut fields = error.split('|');
    if fields.next()? != "podium_lifecycle_observed" {
        return None;
    }
    let observation = LifecycleObservation {
        status: fields.next()?.to_owned(),
        error_code: fields.next()?.to_owned(),
        sanitized_reason: fields.next()?.to_owned(),
        action_required: fields.next()?.parse().ok()?,
        retryable: fields.next()?.parse().ok()?,
        next_action: fields.next()?.to_owned(),
    };
    if fields.next().is_some()
        || !matches!(observation.status.as_str(), "failed" | "degraded")
        || !safe_code(&observation.error_code, 128)
        || !safe_code(&observation.sanitized_reason, 500)
        || !safe_code(&observation.next_action, 128)
    {
        return None;
    }
    Some(observation)
}

fn safe_code(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
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
    fn preserves_a_bounded_lifecycle_failure() {
        let response = serde_json::json!({
            "kind": "handshake.result",
            "request_id": "desktop-start",
            "protocol_version": 1,
            "status": "failed",
            "error_code": "podium_database_startup_failed",
            "sanitized_reason": "database_startup_failed",
            "action_required": true,
            "retryable": false,
            "next_action": "repair_application_data",
        });

        assert_eq!(
            validate_response(&response, "handshake.result", "desktop-start", "ready").unwrap_err(),
            "podium_lifecycle_observed|failed|podium_database_startup_failed|\
             database_startup_failed|true|false|repair_application_data"
        );
    }

    #[test]
    fn accepts_and_preserves_a_bounded_degraded_lifecycle() {
        let response = serde_json::json!({
            "kind": "handshake.result",
            "request_id": "desktop-start",
            "protocol_version": 1,
            "status": "degraded",
            "error_code": "linear_polling_failed",
            "sanitized_reason": "linear_poll_timeout",
            "action_required": true,
            "retryable": true,
            "next_action": "retry_linear_polling",
        });

        assert!(validate_response(&response, "handshake.result", "desktop-start", "ready").is_ok());
        let encoded = LifecycleObservation {
            status: "degraded".into(),
            error_code: "linear_polling_failed".into(),
            sanitized_reason: "linear_poll_timeout".into(),
            action_required: true,
            retryable: true,
            next_action: "retry_linear_polling".into(),
        }
        .encode();
        assert_eq!(
            observed_lifecycle_failure(encoded).unwrap().next_action,
            "retry_linear_polling"
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
