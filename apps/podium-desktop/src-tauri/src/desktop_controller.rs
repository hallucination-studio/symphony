use crate::desktop_lifecycle::{ManagedProcess, ProcessError};
use crate::oauth_return::{OAuthReturn, OAuthReturnRegistry};
use crate::repository_context::{select_repository, validate_base_branch, RepositoryContext};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use symphony_contracts::{DesktopHostDesktopHostMessage, PodiumClientPodiumClientMessage};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug)]
pub enum ControllerError {
    IpcCreateFailed,
    IpcCloneFailed,
    BackendSpawnFailed,
    BackendUnavailable,
    ProtocolInvalid,
    ProtocolIoFailed,
    RepositorySelectionFailed,
    RepositoryMissing,
    RepositoryBranchInvalid,
    ConductorAlreadyRunning,
    ConductorMissing,
    ConductorMismatch,
    ConductorSpawnFailed,
    ConductorShutdownFailed,
    HostCommandUnsupported,
    ExternalOpenFailed,
}

#[derive(Clone)]
struct ConductorConfig {
    binding_id: String,
    conductor_id: String,
    conductor_short_hash: String,
    linear_installation_id: String,
    organization_id: String,
    repository_handle: String,
    repository_root: String,
    base_branch: String,
    conductor_data_root: String,
}

struct ActiveConductor {
    config: ConductorConfig,
    instance_id: String,
    process: ManagedProcess,
}

pub struct DesktopController {
    app: AppHandle,
    client: Mutex<UnixStream>,
    host: Mutex<UnixStream>,
    host_pending: Mutex<HashSet<String>>,
    host_acks: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    conductor_channel: Mutex<UnixStream>,
    repositories: Mutex<HashMap<String, RepositoryContext>>,
    conductors: AsyncMutex<HashMap<String, ActiveConductor>>,
    backend: AsyncMutex<ManagedProcess>,
}

impl DesktopController {
    pub fn start(app: AppHandle) -> Result<Arc<Self>, ControllerError> {
        let (client_parent, client_child) =
            UnixStream::pair().map_err(|_| ControllerError::IpcCreateFailed)?;
        let (host_parent, host_child) =
            UnixStream::pair().map_err(|_| ControllerError::IpcCreateFailed)?;
        let (conductor_backend, conductor_child) =
            UnixStream::pair().map_err(|_| ControllerError::IpcCreateFailed)?;
        let mut command = backend_command(&app)?;
        let client_input = client_child.try_clone().map_err(|_| ControllerError::IpcCloneFailed)?;
        command.stdin(Stdio::from(OwnedFd::from(client_input)));
        command.stdout(Stdio::from(OwnedFd::from(client_child)));
        inherit_stream(&mut command, "SYMPHONY_HOST_IPC_FD", host_child)?;
        inherit_stream(&mut command, "SYMPHONY_CONDUCTOR_IPC_FD", conductor_backend)?;
        let backend =
            ManagedProcess::spawn(command).map_err(|_| ControllerError::BackendSpawnFailed)?;
        let controller = Arc::new(Self {
            app,
            client: Mutex::new(client_parent),
            host: Mutex::new(host_parent.try_clone().map_err(|_| ControllerError::IpcCloneFailed)?),
            host_pending: Mutex::new(HashSet::new()),
            host_acks: Mutex::new(HashMap::new()),
            conductor_channel: Mutex::new(conductor_child),
            repositories: Mutex::new(HashMap::new()),
            conductors: AsyncMutex::new(HashMap::new()),
            backend: AsyncMutex::new(backend),
        });
        let host_controller = controller.clone();
        tauri::async_runtime::spawn(async move {
            let _ = host_controller.serve_host(host_parent).await;
        });
        let monitor_controller = controller.clone();
        tauri::async_runtime::spawn(async move {
            monitor_controller.monitor_conductor().await;
        });
        Ok(controller)
    }

    pub fn client_request(&self, frame: &[u8]) -> Result<Vec<u8>, ControllerError> {
        if frame.is_empty() || frame.len() > 1_064_960 {
            return Err(ControllerError::ProtocolInvalid);
        }
        let newline =
            frame.iter().position(|byte| *byte == b'\n').ok_or(ControllerError::ProtocolInvalid)?;
        let metadata: Value = serde_json::from_slice(&frame[..newline])
            .map_err(|_| ControllerError::ProtocolInvalid)?;
        PodiumClientPodiumClientMessage::try_from(metadata)
            .map_err(|_| ControllerError::ProtocolInvalid)?;
        let mut stream = self.client.lock().map_err(|_| ControllerError::BackendUnavailable)?;
        stream.write_all(frame).map_err(|_| ControllerError::ProtocolIoFailed)?;
        stream.flush().map_err(|_| ControllerError::ProtocolIoFailed)?;
        let response = read_line(&mut stream)?;
        let value: Value =
            serde_json::from_slice(response.strip_suffix(b"\n").unwrap_or(&response))
                .map_err(|_| ControllerError::ProtocolInvalid)?;
        PodiumClientPodiumClientMessage::try_from(value)
            .map_err(|_| ControllerError::ProtocolInvalid)?;
        Ok(response)
    }

    pub async fn select_repository(
        self: &Arc<Self>,
    ) -> Result<Option<RepositoryContext>, ControllerError> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        select_repository(&self.app, move |result| {
            let _ = sender.send(result);
        });
        let selected = receiver
            .await
            .map_err(|_| ControllerError::RepositorySelectionFailed)?
            .map_err(|_| ControllerError::RepositorySelectionFailed)?;
        if let Some(repository) = &selected {
            self.repositories
                .lock()
                .map_err(|_| ControllerError::RepositorySelectionFailed)?
                .insert(repository.repository_handle.clone(), repository.clone());
        }
        Ok(selected)
    }

    pub fn forward_oauth_return(&self, result: OAuthReturn) -> Result<(), ControllerError> {
        let request_id = format!("oauth-return-{}", result.attempt_id);
        let message = json!({
            "protocol_version": "1",
            "request_id": request_id,
            "body": {
                "kind": "oauth_return",
                "attempt_id": result.attempt_id,
                "state": result.state,
                "authorization_code": result.authorization_code,
            }
        });
        DesktopHostDesktopHostMessage::try_from(message.clone())
            .map_err(|_| ControllerError::ProtocolInvalid)?;
        self.send_host_event(request_id, message)
    }

    fn send_host_event(&self, request_id: String, message: Value) -> Result<(), ControllerError> {
        self.host_pending.lock().map_err(|_| ControllerError::ProtocolIoFailed)?.insert(request_id);
        let mut host = self.host.lock().map_err(|_| ControllerError::ProtocolIoFailed)?;
        host.write_all(format!("{message}\n").as_bytes())
            .map_err(|_| ControllerError::ProtocolIoFailed)?;
        host.flush().map_err(|_| ControllerError::ProtocolIoFailed)
    }

    async fn serve_host(self: Arc<Self>, stream: UnixStream) -> Result<(), ControllerError> {
        let reader_stream = stream.try_clone().map_err(|_| ControllerError::IpcCloneFailed)?;
        let mut reader = BufReader::new(reader_stream);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).map_err(|_| ControllerError::ProtocolIoFailed)? == 0 {
                return Ok(());
            }
            if line.len() > 1_048_576 {
                return Err(ControllerError::ProtocolInvalid);
            }
            let request: Value =
                serde_json::from_str(&line).map_err(|_| ControllerError::ProtocolInvalid)?;
            DesktopHostDesktopHostMessage::try_from(request.clone())
                .map_err(|_| ControllerError::ProtocolInvalid)?;
            let request_id = string_field(&request, "request_id")?;
            if self
                .host_pending
                .lock()
                .map_err(|_| ControllerError::ProtocolIoFailed)?
                .remove(request_id)
            {
                let accepted =
                    request.get("body").and_then(|body| body.get("kind")).and_then(Value::as_str)
                        == Some("host_command_accepted");
                if let Some(sender) = self
                    .host_acks
                    .lock()
                    .map_err(|_| ControllerError::ProtocolIoFailed)?
                    .remove(request_id)
                {
                    let _ = sender.send(accepted);
                }
                continue;
            }
            let body = request
                .get("body")
                .and_then(Value::as_object)
                .ok_or(ControllerError::ProtocolInvalid)?;
            let response_body = match self.handle_host(body).await {
                Ok(value) => value,
                Err(error) => protocol_error(error),
            };
            let response = json!({
                "protocol_version": "1",
                "request_id": request_id,
                "body": response_body,
            });
            DesktopHostDesktopHostMessage::try_from(response.clone())
                .map_err(|_| ControllerError::ProtocolInvalid)?;
            let mut writer = self.host.lock().map_err(|_| ControllerError::ProtocolIoFailed)?;
            writer
                .write_all(format!("{response}\n").as_bytes())
                .map_err(|_| ControllerError::ProtocolIoFailed)?;
            writer.flush().map_err(|_| ControllerError::ProtocolIoFailed)?;
        }
    }

    async fn handle_host(
        &self,
        body: &serde_json::Map<String, Value>,
    ) -> Result<Value, ControllerError> {
        match body.get("kind").and_then(Value::as_str) {
            Some("open_external_url") => {
                let attempt_id = map_string(body, "attempt_id")?;
                let url = map_string(body, "url")?;
                let state = url::Url::parse(url)
                    .ok()
                    .and_then(|url| {
                        url.query_pairs()
                            .find(|(name, _)| name == "state")
                            .map(|(_, value)| value.into_owned())
                    })
                    .ok_or(ControllerError::ProtocolInvalid)?;
                self.app
                    .state::<Arc<OAuthReturnRegistry>>()
                    .register(attempt_id, &state)
                    .map_err(|_| ControllerError::ProtocolInvalid)?;
                self.app
                    .opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| ControllerError::ExternalOpenFailed)?;
                Ok(accepted("open_external_url"))
            }
            Some("resolve_repository") => {
                let handle = map_string(body, "repository_handle")?;
                let branch = map_string(body, "base_branch")?;
                let repositories =
                    self.repositories.lock().map_err(|_| ControllerError::RepositoryMissing)?;
                let repository =
                    repositories.get(handle).ok_or(ControllerError::RepositoryMissing)?;
                validate_base_branch(repository, branch)
                    .map_err(|_| ControllerError::RepositoryBranchInvalid)?;
                Ok(repository_value(repository))
            }
            Some("start_conductor") => {
                self.start_conductor(parse_conductor(body)?).await?;
                Ok(accepted("start_conductor"))
            }
            Some("stop_conductor") => {
                self.stop_conductor(map_string(body, "conductor_id")?).await?;
                Ok(accepted("stop_conductor"))
            }
            Some("restart_conductor") => {
                self.restart_conductor(map_string(body, "conductor_id")?).await?;
                Ok(accepted("restart_conductor"))
            }
            _ => Err(ControllerError::HostCommandUnsupported),
        }
    }

    async fn start_conductor(&self, config: ConductorConfig) -> Result<(), ControllerError> {
        let mut active = self.conductors.lock().await;
        if active.contains_key(&config.binding_id) {
            return Err(ControllerError::ConductorAlreadyRunning);
        }
        let (process, instance_id) = self.spawn_conductor(&config)?;
        active.insert(config.binding_id.clone(), ActiveConductor { config, instance_id, process });
        Ok(())
    }

    async fn monitor_conductor(&self) {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let replacement = {
                let mut active = self.conductors.lock().await;
                let binding_ids = active.keys().cloned().collect::<Vec<_>>();
                let mut replacements = Vec::new();
                for binding_id in binding_ids {
                    let Some(current) = active.get_mut(&binding_id) else { continue };
                    let tree_exited = match current.process.try_observed_exit() {
                        Ok(Some(_)) => true,
                        Ok(None) => false,
                        Err(ProcessError::ProcessTreeStillRunning) => {
                            current.process.shutdown_within(Duration::from_secs(5)).await.is_ok()
                        }
                        Err(_) => false,
                    };
                    if !tree_exited {
                        continue;
                    }
                    let config = current.config.clone();
                    if self
                        .forward_process_exit(
                            &config,
                            &current.instance_id,
                            "conductor_process_exited",
                        )
                        .await
                        .is_ok()
                    {
                        active.remove(&binding_id);
                        replacements.push(config);
                    }
                }
                replacements
            };
            for config in replacement {
                let _ = self.start_conductor(config).await;
            }
        }
    }

    async fn stop_conductor(&self, conductor_id: &str) -> Result<(), ControllerError> {
        let mut active = self.conductors.lock().await;
        let binding_id = binding_for_conductor(&active, conductor_id)?;
        let current = active.get_mut(&binding_id).ok_or(ControllerError::ConductorMissing)?;
        current
            .process
            .shutdown_within(Duration::from_secs(5))
            .await
            .map_err(|_| ControllerError::ConductorShutdownFailed)?;
        self.forward_process_exit(
            &current.config,
            &current.instance_id,
            "conductor_process_stopped",
        )
        .await?;
        active.remove(&binding_id);
        Ok(())
    }

    async fn restart_conductor(&self, conductor_id: &str) -> Result<(), ControllerError> {
        let config = {
            let active = self.conductors.lock().await;
            let binding_id = binding_for_conductor(&active, conductor_id)?;
            let current = active.get(&binding_id).ok_or(ControllerError::ConductorMissing)?;
            current.config.clone()
        };
        self.stop_conductor(conductor_id).await?;
        self.start_conductor(config).await
    }

    fn spawn_conductor(
        &self,
        config: &ConductorConfig,
    ) -> Result<(ManagedProcess, String), ControllerError> {
        let executable = std::env::var_os("SYMPHONY_CONDUCTOR_EXECUTABLE")
            .map(PathBuf::from)
            .or_else(|| bundled_executable("conductor"))
            .unwrap_or_else(|| PathBuf::from("conductor"));
        let mut command = Command::new(executable);
        let channel = self
            .conductor_channel
            .lock()
            .map_err(|_| ControllerError::IpcCloneFailed)?
            .try_clone()
            .map_err(|_| ControllerError::IpcCloneFailed)?;
        inherit_stream(&mut command, "SYMPHONY_PRIVATE_IPC_FD", channel)?;
        let instance_id = uuid_like();
        command
            .env("SYMPHONY_INSTANCE_ID", &instance_id)
            .env("SYMPHONY_BINDING_ID", &config.binding_id)
            .env("SYMPHONY_CONDUCTOR_ID", &config.conductor_id)
            .env("SYMPHONY_CONDUCTOR_SHORT_HASH", &config.conductor_short_hash)
            .env("SYMPHONY_LINEAR_INSTALLATION_ID", &config.linear_installation_id)
            .env("SYMPHONY_ORGANIZATION_ID", &config.organization_id)
            .env("SYMPHONY_REPOSITORY_HANDLE", &config.repository_handle)
            .env("SYMPHONY_REPOSITORY_ROOT", &config.repository_root)
            .env("SYMPHONY_BASE_BRANCH", &config.base_branch)
            .env("SYMPHONY_CONDUCTOR_DATA_ROOT", &config.conductor_data_root);
        if let Some(performer) = bundled_executable("performer") {
            command.env("SYMPHONY_PERFORMER_EXECUTABLE", performer);
        }
        let process =
            ManagedProcess::spawn(command).map_err(|_| ControllerError::ConductorSpawnFailed)?;
        Ok((process, instance_id))
    }

    pub async fn shutdown(&self) {
        let mut conductors = self.conductors.lock().await;
        for active in conductors.values_mut() {
            let _ = active.process.shutdown_within(Duration::from_secs(5)).await;
        }
        conductors.clear();
        let _ = self.backend.lock().await.shutdown_within(Duration::from_secs(5)).await;
    }

    async fn forward_process_exit(
        &self,
        config: &ConductorConfig,
        instance_id: &str,
        reason: &str,
    ) -> Result<(), ControllerError> {
        let request_id = format!("process-exit-{instance_id}");
        let message = json!({
            "protocol_version": "1",
            "request_id": request_id,
            "body": {
                "kind": "process_observed_exit",
                "binding_id": config.binding_id,
                "instance_id": instance_id,
                "observed_at": chrono::Utc::now().to_rfc3339(),
                "sanitized_reason": reason,
            }
        });
        DesktopHostDesktopHostMessage::try_from(message.clone())
            .map_err(|_| ControllerError::ProtocolInvalid)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.host_acks
            .lock()
            .map_err(|_| ControllerError::ProtocolIoFailed)?
            .insert(request_id.clone(), sender);
        self.send_host_event(request_id.clone(), message)?;
        let accepted = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| ControllerError::ProtocolIoFailed)?
            .map_err(|_| ControllerError::ProtocolIoFailed)?;
        if accepted {
            Ok(())
        } else {
            Err(ControllerError::ProtocolIoFailed)
        }
    }
}

fn binding_for_conductor(
    active: &HashMap<String, ActiveConductor>,
    conductor_id: &str,
) -> Result<String, ControllerError> {
    let matches = active
        .iter()
        .filter(|(_, generation)| generation.config.conductor_id == conductor_id)
        .map(|(binding_id, _)| binding_id.clone())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [binding_id] => Ok(binding_id.clone()),
        [] => Err(ControllerError::ConductorMissing),
        _ => Err(ControllerError::ConductorMismatch),
    }
}

fn backend_command(app: &AppHandle) -> Result<Command, ControllerError> {
    let configured_script = std::env::var_os("SYMPHONY_PODIUM_BACKEND_SCRIPT").map(PathBuf::from);
    let data_root = app.path().app_data_dir().map_err(|_| ControllerError::BackendUnavailable)?;
    std::fs::create_dir_all(&data_root).map_err(|_| ControllerError::BackendUnavailable)?;
    let mut command = if let Some(executable) = bundled_executable("podium-backend") {
        Command::new(executable)
    } else {
        let node = std::env::var_os("SYMPHONY_NODE_EXECUTABLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        let mut command = Command::new(node);
        command.arg(configured_script.unwrap_or_else(|| PathBuf::from("dist-backend/main.js")));
        command
    };
    command
        .env("SYMPHONY_PODIUM_DATA_ROOT", data_root)
        .env(
            "SYMPHONY_LINEAR_CLIENT_ID",
            std::env::var("SYMPHONY_LINEAR_CLIENT_ID").unwrap_or_default(),
        )
        .env(
            "SYMPHONY_LINEAR_CLIENT_SECRET",
            std::env::var("SYMPHONY_LINEAR_CLIENT_SECRET").unwrap_or_default(),
        )
        .stderr(Stdio::inherit());
    Ok(command)
}

fn bundled_executable(name: &str) -> Option<PathBuf> {
    let directory = std::env::current_exe().ok()?.parent()?.to_owned();
    let candidate = directory.join(name);
    candidate.is_file().then_some(candidate)
}

fn inherit_stream(
    command: &mut Command,
    variable: &str,
    stream: UnixStream,
) -> Result<(), ControllerError> {
    let fd = stream.as_raw_fd();
    command.env(variable, fd.to_string());
    let owned = OwnedFd::from(stream);
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let _keep_open = &owned;
            Ok(())
        });
    }
    Ok(())
}

fn read_line(stream: &mut UnixStream) -> Result<Vec<u8>, ControllerError> {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while bytes.len() <= 1_048_576 {
        stream.read_exact(&mut byte).map_err(|_| ControllerError::ProtocolIoFailed)?;
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(bytes);
        }
    }
    Err(ControllerError::ProtocolInvalid)
}

fn parse_conductor(
    body: &serde_json::Map<String, Value>,
) -> Result<ConductorConfig, ControllerError> {
    Ok(ConductorConfig {
        binding_id: map_string(body, "binding_id")?.to_owned(),
        conductor_id: map_string(body, "conductor_id")?.to_owned(),
        conductor_short_hash: map_string(body, "conductor_short_hash")?.to_owned(),
        linear_installation_id: map_string(body, "linear_installation_id")?.to_owned(),
        organization_id: map_string(body, "organization_id")?.to_owned(),
        repository_handle: map_string(body, "repository_handle")?.to_owned(),
        repository_root: map_string(body, "repository_root")?.to_owned(),
        base_branch: map_string(body, "base_branch")?.to_owned(),
        conductor_data_root: map_string(body, "conductor_data_root")?.to_owned(),
    })
}

fn repository_value(repository: &RepositoryContext) -> Value {
    json!({
        "kind": "repository_context",
        "repository_handle": repository.repository_handle,
        "canonical_path": repository.canonical_path,
        "display_name": repository.display_name.to_string_lossy(),
        "remote_display": repository.remote_display,
        "base_branches": repository.base_branches,
    })
}

fn accepted(kind: &str) -> Value {
    json!({ "kind": "host_command_accepted", "command_kind": kind })
}

fn protocol_error(error: ControllerError) -> Value {
    let code = match error {
        ControllerError::RepositoryMissing => "repository_handle_missing",
        ControllerError::RepositoryBranchInvalid => "repository_base_branch_invalid",
        ControllerError::ConductorAlreadyRunning => "conductor_already_running",
        ControllerError::ConductorMissing => "conductor_not_running",
        ControllerError::ConductorMismatch => "conductor_identity_mismatch",
        ControllerError::ConductorShutdownFailed => "conductor_shutdown_failed",
        ControllerError::ConductorSpawnFailed => "conductor_spawn_failed",
        _ => "desktop_host_command_failed",
    };
    json!({
        "code": code,
        "category": "desktop_host",
        "sanitized_reason": code,
        "retryable": false,
        "action_required": "check_desktop",
        "next_action": "Resolve the local Desktop runtime problem before retrying."
    })
}

fn map_string<'a>(
    body: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, ControllerError> {
    body.get(key).and_then(Value::as_str).ok_or(ControllerError::ProtocolInvalid)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, ControllerError> {
    value.get(key).and_then(Value::as_str).ok_or(ControllerError::ProtocolInvalid)
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!(
        "instance-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
    )
}

#[allow(dead_code)]
fn _is_absolute(path: &str) -> bool {
    Path::new(path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generation(binding_id: &str, conductor_id: &str) -> ActiveConductor {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 0"]);
        ActiveConductor {
            config: ConductorConfig {
                binding_id: binding_id.to_owned(),
                conductor_id: conductor_id.to_owned(),
                conductor_short_hash: "short".to_owned(),
                linear_installation_id: "installation".to_owned(),
                organization_id: "organization".to_owned(),
                repository_handle: "repository".to_owned(),
                repository_root: "/repository".to_owned(),
                base_branch: "main".to_owned(),
                conductor_data_root: "/data".to_owned(),
            },
            instance_id: format!("instance-{binding_id}"),
            process: ManagedProcess::spawn(command).unwrap(),
        }
    }

    #[test]
    fn generation_lookup_keeps_bindings_independent_and_rejects_ambiguity() {
        let mut active = HashMap::new();
        active.insert("binding-1".to_owned(), generation("binding-1", "conductor-1"));
        active.insert("binding-2".to_owned(), generation("binding-2", "conductor-2"));
        assert_eq!(binding_for_conductor(&active, "conductor-1").unwrap(), "binding-1");
        active.insert("binding-3".to_owned(), generation("binding-3", "conductor-1"));
        assert!(matches!(
            binding_for_conductor(&active, "conductor-1"),
            Err(ControllerError::ConductorMismatch)
        ));
        for generation in active.values_mut() {
            generation.process.observed_exit().unwrap();
        }
    }
}
