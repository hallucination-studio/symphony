use crate::podium_process::PodiumProcess;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

pub(crate) type PodiumProcessState = Arc<Mutex<Option<PodiumProcess>>>;

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub(crate) fn podium_command(request: Value, state: State<'_, PodiumProcessState>) -> Value {
    let request_id =
        format!("desktop-command-{}", REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let (command, input) = match validate_request(&request) {
        Ok(parts) => parts,
        Err(code) => return error_response(&request_id, "unknown", code),
    };
    let framed = json!({
        "kind": "command",
        "request_id": request_id,
        "protocol_version": 1,
        "command": command,
        "input": input,
    });
    let response =
        state.lock().ok().and_then(|mut process| process.as_mut()?.command(&framed).ok());
    match response.filter(|value| valid_response(value, command, &request_id)) {
        Some(value) => value,
        None => {
            eprintln!(
                "event=podium_desktop_command_transport_failed request_id={request_id} \
                 command={command} error_type=local_transport \
                 error_code=desktop_command_transport_failed \
                 sanitized_reason=command_transport_failed action_required=true \
                 retryable=false next_action=restart_desktop"
            );
            error_response(&request_id, command, "desktop_command_transport_failed")
        }
    }
}

fn validate_request(request: &Value) -> Result<(&str, &Map<String, Value>), &'static str> {
    let object = request
        .as_object()
        .filter(|object| {
            object.len() == 2 && object.contains_key("command") && object.contains_key("input")
        })
        .ok_or("desktop_command_request_invalid")?;
    let command = object["command"].as_str().ok_or("desktop_command_request_invalid")?;
    let input = object["input"].as_object().ok_or("desktop_command_request_invalid")?;
    if command != "lifecycle.snapshot" {
        return Err("desktop_command_unsupported");
    }
    if !input.is_empty() {
        return Err("desktop_command_input_invalid");
    }
    Ok((command, input))
}

fn valid_response(value: &Value, command: &str, request_id: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let valid_common = object.get("kind").and_then(Value::as_str) == Some("command.result")
        && object.get("request_id").and_then(Value::as_str) == Some(request_id)
        && object.get("protocol_version").and_then(Value::as_u64) == Some(1)
        && object.get("command").and_then(Value::as_str) == Some(command)
        && object.get("ok").and_then(Value::as_bool).is_some()
        && !contains_forbidden_key(value);
    if !valid_common {
        return false;
    }
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            exact_keys(
                object,
                &["kind", "request_id", "protocol_version", "command", "ok", "output"],
            ) && valid_lifecycle_snapshot(object.get("output"))
        }
        Some(false) => {
            exact_keys(
                object,
                &["kind", "request_id", "protocol_version", "command", "ok", "error"],
            ) && valid_error(object.get("error"))
        }
        None => false,
    }
}

fn valid_lifecycle_snapshot(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    exact_keys(
        object,
        &[
            "status",
            "installation_status",
            "error_code",
            "sanitized_reason",
            "action_required",
            "retryable",
            "next_action",
        ],
    ) && matches!(
        object.get("status").and_then(Value::as_str),
        Some("starting" | "ready" | "degraded" | "failed" | "stopping" | "stopped")
    ) && safe_value_code(object.get("installation_status"), 128)
        && nullable_safe_code(object.get("error_code"), 128)
        && nullable_safe_code(object.get("sanitized_reason"), 500)
        && object.get("action_required").and_then(Value::as_bool).is_some()
        && object.get("retryable").and_then(Value::as_bool).is_some()
        && safe_value_code(object.get("next_action"), 128)
}

fn valid_error(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    exact_keys(object, &["code", "sanitized_reason", "action_required", "retryable", "next_action"])
        && safe_value_code(object.get("code"), 128)
        && safe_value_code(object.get("sanitized_reason"), 500)
        && object.get("action_required").and_then(Value::as_bool).is_some()
        && object.get("retryable").and_then(Value::as_bool).is_some()
        && safe_value_code(object.get("next_action"), 128)
}

fn exact_keys(object: &Map<String, Value>, fields: &[&str]) -> bool {
    object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
}

fn nullable_safe_code(value: Option<&Value>, limit: usize) -> bool {
    value == Some(&Value::Null) || safe_value_code(value, limit)
}

fn safe_value_code(value: Option<&Value>, limit: usize) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| safe_code(value, limit))
}

fn safe_code(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn contains_forbidden_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "access_token" | "refresh_token" | "client_secret" | "authorization" | "sql"
            ) || contains_forbidden_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_forbidden_key),
        _ => false,
    }
}

fn error_response(request_id: &str, command: &str, code: &str) -> Value {
    json!({
        "kind": "command.result",
        "request_id": request_id,
        "protocol_version": 1,
        "command": command,
        "ok": false,
        "error": {
            "code": code,
            "sanitized_reason": code,
            "action_required": true,
            "retryable": false,
            "next_action": "restart_desktop",
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_lifecycle_command() {
        assert!(validate_request(&json!({
            "command": "lifecycle.snapshot",
            "input": {},
        }))
        .is_ok());
        assert_eq!(
            validate_request(&json!({"command": "shell.execute", "input": {}})).unwrap_err(),
            "desktop_command_unsupported"
        );
        assert_eq!(
            validate_request(&json!({
                "command": "lifecycle.snapshot",
                "input": {"path": "/tmp/podium.db"},
            }))
            .unwrap_err(),
            "desktop_command_input_invalid"
        );
    }

    #[test]
    fn rejects_secret_or_sql_fields_from_sidecar_responses() {
        let response = json!({
            "kind": "command.result",
            "request_id": "desktop-command-1",
            "protocol_version": 1,
            "command": "lifecycle.snapshot",
            "ok": true,
            "output": {"access_token": "secret"},
        });
        assert!(!valid_response(&response, "lifecycle.snapshot", "desktop-command-1"));
    }

    #[test]
    fn accepts_only_exact_success_response_fields() {
        let success = json!({
            "kind": "command.result",
            "request_id": "desktop-command-1",
            "protocol_version": 1,
            "command": "lifecycle.snapshot",
            "ok": true,
            "output": {
                "status": "ready",
                "installation_status": "not_installed",
                "error_code": null,
                "sanitized_reason": null,
                "action_required": false,
                "retryable": false,
                "next_action": "none",
            },
        });
        assert!(valid_response(&success, "lifecycle.snapshot", "desktop-command-1"));
        let mut extra = success;
        extra["output"]["unexpected"] = Value::Bool(true);
        assert!(!valid_response(&extra, "lifecycle.snapshot", "desktop-command-1"));
    }
}
