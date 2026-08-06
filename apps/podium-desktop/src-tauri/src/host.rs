use crate::credentials::{CredentialStore, StoredCredentials};
use crate::domain::ProjectBinding;
use crate::launch::{ConductorLauncher, LaunchError, LaunchRequest, RunningConductor};
use crate::linear::{LinearCandidateAdapter, LinearError, LinearProject, ReqwestLinearTransport};
use crate::oauth::{self, OAuthEndpoints, OAuthError, REFRESH_SKEW_SECONDS};
use crate::resources::{ResourceError, RootResourceAllocator, RootResources};
use crate::runtime::{
    AllocationProvider, CandidateRecord, CandidateSource, DesktopSnapshot, ProcessLauncher,
    RootActionKind, RootActionTarget, RootView, Runtime, RuntimeError, RuntimeEvent,
};
use crate::store::JsonStore;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{Manager, State};

/// Desktop-owned Linear session (TM-CRED-001..007).  Holds the only token
/// copy, refreshes it in place, and answers the current access token for
/// candidate polling and Conductor launches.
pub struct TokenProvider {
    store: CredentialStore,
    client: Option<reqwest::blocking::Client>,
    endpoints: OAuthEndpoints,
    state: Mutex<ConnectionState>,
}

enum ConnectionState {
    Disconnected,
    Connected(StoredCredentials),
    ReconnectRequired,
}

/// Public connection projection.  Tokens are never part of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LinearConnectionView {
    Connected { organization: String },
    Disconnected,
    ReconnectRequired,
}

impl TokenProvider {
    fn new(data_root: &Path, endpoints: OAuthEndpoints) -> Self {
        let store = CredentialStore::new(data_root);
        let client =
            reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).build().ok();
        let state = match store.load() {
            Ok(Some(credentials)) => ConnectionState::Connected(credentials),
            Ok(None) => ConnectionState::Disconnected,
            // A malformed credentials document is never a silent disconnect;
            // the operator sees the reconnect surface instead (TM-CRED-007).
            Err(_) => ConnectionState::ReconnectRequired,
        };
        Self { store, client, endpoints, state: Mutex::new(state) }
    }

    pub fn view(&self) -> LinearConnectionView {
        match &*lock(&self.state) {
            ConnectionState::Connected(credentials) => {
                LinearConnectionView::Connected { organization: credentials.organization.clone() }
            }
            ConnectionState::Disconnected => LinearConnectionView::Disconnected,
            ConnectionState::ReconnectRequired => LinearConnectionView::ReconnectRequired,
        }
    }

    /// The current app-actor access token, refreshing in place when inside
    /// the expiry skew window.  Provider rejection flips the connection to
    /// `ReconnectRequired`; transport failures keep the session and surface
    /// as bounded errors (TM-CRED-004).
    fn access_token(&self) -> Result<String, OAuthError> {
        let client = self.client.as_ref().ok_or(OAuthError::Transport)?;
        let mut state = lock(&self.state);
        let ConnectionState::Connected(credentials) = &mut *state else {
            return Err(OAuthError::NotConnected);
        };
        if !credentials.access_token_expires_within(REFRESH_SKEW_SECONDS, now_unix()) {
            return Ok(credentials.access_token.clone());
        }
        let client_id = credentials.client_id.clone();
        let organization = credentials.organization.clone();
        let refresh_token = credentials.refresh_token.clone();
        match oauth::refresh_tokens(client, &self.endpoints.token, &client_id, &refresh_token) {
            Ok(tokens) => {
                let next = StoredCredentials::new(
                    client_id,
                    organization,
                    tokens.access_token.clone(),
                    tokens.refresh_token,
                    now_unix() + tokens.expires_in,
                )
                .map_err(|_| OAuthError::InvalidResponse)?;
                self.store.replace(&next).map_err(|_| OAuthError::Transport)?;
                let access_token = next.access_token.clone();
                *state = ConnectionState::Connected(next);
                Ok(access_token)
            }
            Err(error) => {
                if error == OAuthError::ProviderRejected {
                    *state = ConnectionState::ReconnectRequired;
                }
                Err(error)
            }
        }
    }

    /// Run the full browser authorization flow and persist the session.
    fn connect(&self, cancel: &AtomicBool) -> Result<LinearConnectionView, OAuthError> {
        let client_id = oauth::builtin_client_id().ok_or(OAuthError::MissingClientId)?;
        let client = self.client.as_ref().ok_or(OAuthError::Transport)?;
        let session = oauth::begin_authorization(client_id)?;
        tauri_plugin_opener::open_url(&session.authorize_url, None::<&str>)
            .map_err(|_| OAuthError::Transport)?;
        let code = session.wait_for_code(cancel)?;
        let tokens = session.complete(&code, client, &self.endpoints)?;
        let credentials = StoredCredentials::new(
            client_id,
            tokens.organization,
            tokens.access_token,
            tokens.refresh_token,
            now_unix() + tokens.expires_in,
        )
        .map_err(|_| OAuthError::InvalidResponse)?;
        self.store.replace(&credentials).map_err(|_| OAuthError::Transport)?;
        *lock(&self.state) = ConnectionState::Connected(credentials);
        Ok(self.view())
    }

    fn disconnect(&self) -> Result<(), OAuthError> {
        self.store.clear().map_err(|_| OAuthError::Transport)?;
        *lock(&self.state) = ConnectionState::Disconnected;
        Ok(())
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct LinearCandidates {
    adapter: LinearCandidateAdapter<ReqwestLinearTransport>,
    connection: Arc<TokenProvider>,
}

impl CandidateSource for LinearCandidates {
    type Error = LinearError;

    fn candidates(
        &mut self,
        binding: &ProjectBinding,
    ) -> Result<Vec<CandidateRecord>, Self::Error> {
        let token = self.connection.access_token().map_err(|_| LinearError::MissingApiKey)?;
        self.adapter.set_access_token(&token);
        self.adapter.list_root_candidates(binding).map(|roots| {
            roots
                .into_iter()
                .map(|root| {
                    CandidateRecord::new(root.to_root_candidate(), root.identifier, root.title)
                })
                .collect()
        })
    }
}

struct RootResourcesProvider(RootResourceAllocator);

impl AllocationProvider for RootResourcesProvider {
    type Error = ResourceError;

    fn allocate(
        &mut self,
        _binding: &ProjectBinding,
        candidate: &CandidateRecord,
    ) -> Result<RootResources, Self::Error> {
        self.0.allocate(&candidate.candidate.id)
    }

    fn cleanup_workspace(
        &mut self,
        binding: &ProjectBinding,
        root_id: &str,
    ) -> Result<(), Self::Error> {
        self.0.cleanup_workspace(Path::new(&binding.repository_path), root_id)
    }
}

struct LocalProcesses {
    launcher: ConductorLauncher,
    connection: Arc<TokenProvider>,
}

impl ProcessLauncher for LocalProcesses {
    type Handle = RunningConductor;
    type Error = LaunchError;

    fn launch(&mut self, request: &LaunchRequest) -> Result<Self::Handle, Self::Error> {
        let token = self.connection.access_token().map_err(|_| LaunchError::NotConnected)?;
        self.launcher.set_linear_token(&token);
        self.launcher.launch(request)
    }
}

type LocalRuntime = Runtime<LinearCandidates, RootResourcesProvider, LocalProcesses>;

enum HostRuntime {
    Ready(Box<LocalRuntime>),
    Unavailable,
}

pub struct DesktopHost {
    runtime: Mutex<HostRuntime>,
    connection: Arc<TokenProvider>,
    projects: Option<LinearCandidateAdapter<ReqwestLinearTransport>>,
    pending_connect: Mutex<Option<Arc<AtomicBool>>>,
}

impl DesktopHost {
    fn initialize(app_data_directory: &Path) -> Self {
        let data_root = app_data_directory.join("podium");
        let connection = Arc::new(TokenProvider::new(&data_root, OAuthEndpoints::default()));
        let transport = ReqwestLinearTransport::new(Duration::from_secs(15)).ok();
        let runtime = transport
            .clone()
            .and_then(|transport| create_runtime(&data_root, connection.clone(), transport).ok())
            .map(Box::new)
            .map(HostRuntime::Ready)
            .unwrap_or(HostRuntime::Unavailable);
        let projects = transport.map(LinearCandidateAdapter::deferred);
        Self {
            runtime: Mutex::new(runtime),
            connection,
            projects,
            pending_connect: Mutex::new(None),
        }
    }

    fn with_runtime<T>(
        &self,
        operation: impl FnOnce(&mut LocalRuntime) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = lock(&self.runtime);
        match &mut *state {
            HostRuntime::Ready(runtime) => operation(runtime),
            HostRuntime::Unavailable => Err(fixed_error()),
        }
    }
}

fn fixed_error() -> String {
    "podium_runtime_unavailable".to_owned()
}

fn create_runtime(
    data_root: &Path,
    connection: Arc<TokenProvider>,
    transport: ReqwestLinearTransport,
) -> Result<LocalRuntime, ()> {
    std::fs::create_dir_all(data_root).map_err(|_| ())?;
    let candidates = LinearCandidates {
        adapter: LinearCandidateAdapter::deferred(transport),
        connection: connection.clone(),
    };
    Runtime::new(
        JsonStore::new(data_root.join("state.json")),
        candidates,
        RootResourcesProvider(RootResourceAllocator::new(data_root)),
        LocalProcesses { launcher: ConductorLauncher::from_environment(), connection },
    )
    .map_err(|_| ())
}

/// Public snapshot: runtime values plus the Linear connection projection.
/// Secrets, process handles, and tokens are never part of this value.
#[derive(Serialize)]
struct HostSnapshot {
    bindings: Vec<ProjectBinding>,
    roots: Vec<RootView>,
    events: Vec<RuntimeEvent>,
    linear: LinearConnectionView,
}

#[tauri::command]
fn get_desktop_snapshot(host: State<'_, DesktopHost>) -> Result<HostSnapshot, String> {
    host.with_runtime(|runtime| {
        runtime.tick().map_err(|_| fixed_error())?;
        let DesktopSnapshot { bindings, roots, events } = runtime.snapshot();
        Ok(HostSnapshot { bindings, roots, events, linear: host.connection.view() })
    })
}

#[tauri::command]
fn upsert_binding(host: State<'_, DesktopHost>, binding: ProjectBinding) -> Result<(), String> {
    host.with_runtime(|runtime| runtime.upsert_binding(binding).map_err(|_| fixed_error()))
}

#[tauri::command]
fn delete_binding(host: State<'_, DesktopHost>, binding_id: String) -> Result<(), String> {
    host.with_runtime(|runtime| runtime.delete_binding(&binding_id).map_err(|_| fixed_error()))
}

#[tauri::command]
fn start_binding(host: State<'_, DesktopHost>, binding_id: String) -> Result<(), String> {
    host.with_runtime(|runtime| {
        runtime.start_binding(&binding_id).map_err(|_| fixed_error())?;
        runtime.tick().map_err(|_| fixed_error())
    })
}

#[tauri::command]
fn stop_binding(host: State<'_, DesktopHost>, binding_id: String) -> Result<(), String> {
    host.with_runtime(|runtime| runtime.stop_binding(&binding_id).map_err(|_| fixed_error()))
}

fn root_action_unavailable_reason(kind: &str) -> &'static str {
    match kind {
        "open_linear" => "root_open_linear_unavailable",
        "open_workspace" => "root_open_workspace_unavailable",
        "open_delivery" => "root_open_delivery_unavailable",
        "open_diagnostics" => "root_open_diagnostics_unavailable",
        "cleanup_workspace" => "root_cleanup_workspace_unavailable",
        _ => "root_action_unavailable",
    }
}

fn root_action_name(kind: RootActionKind) -> &'static str {
    match kind {
        RootActionKind::OpenLinear => "open_linear",
        RootActionKind::OpenWorkspace => "open_workspace",
        RootActionKind::OpenDelivery => "open_delivery",
        RootActionKind::OpenDiagnostics => "open_diagnostics",
        RootActionKind::CleanupWorkspace => "cleanup_workspace",
    }
}

fn root_action_failed_reason(kind: RootActionKind) -> &'static str {
    match kind {
        RootActionKind::OpenLinear => "root_open_linear_failed",
        RootActionKind::OpenWorkspace => "root_open_workspace_failed",
        RootActionKind::OpenDelivery => "root_open_delivery_failed",
        RootActionKind::OpenDiagnostics => "root_open_diagnostics_failed",
        RootActionKind::CleanupWorkspace => "root_action_failed",
    }
}

fn root_action(
    host: State<'_, DesktopHost>,
    root_id: String,
    kind: RootActionKind,
) -> Result<(), String> {
    if root_id.trim().is_empty() {
        return Err("root_id_invalid".to_owned());
    }
    let name = root_action_name(kind);
    host.with_runtime(|runtime| {
        let target = runtime.root_action_target(&root_id, kind).map_err(|error| match error {
            RuntimeError::RootNotFound => RuntimeError::RootNotFound.to_string(),
            RuntimeError::RootActionUnavailable => root_action_unavailable_reason(name).to_owned(),
            other => other.to_string(),
        })?;
        let opened = match target {
            RootActionTarget::Url(url) => tauri_plugin_opener::open_url(url, None::<&str>),
            RootActionTarget::Path(path) => tauri_plugin_opener::open_path(path, None::<&str>),
        };
        opened.map_err(|_| root_action_failed_reason(kind).to_owned())
    })
}

#[tauri::command]
fn open_linear(host: State<'_, DesktopHost>, root_id: String) -> Result<(), String> {
    root_action(host, root_id, RootActionKind::OpenLinear)
}

#[tauri::command]
fn open_workspace(host: State<'_, DesktopHost>, root_id: String) -> Result<(), String> {
    root_action(host, root_id, RootActionKind::OpenWorkspace)
}

#[tauri::command]
fn open_delivery(host: State<'_, DesktopHost>, root_id: String) -> Result<(), String> {
    root_action(host, root_id, RootActionKind::OpenDelivery)
}

#[tauri::command]
fn open_diagnostics(host: State<'_, DesktopHost>, root_id: String) -> Result<(), String> {
    root_action(host, root_id, RootActionKind::OpenDiagnostics)
}

#[tauri::command]
fn cleanup_workspace(host: State<'_, DesktopHost>, root_id: String) -> Result<(), String> {
    if root_id.trim().is_empty() {
        return Err("root_id_invalid".to_owned());
    }
    host.with_runtime(|runtime| {
        runtime.cleanup_workspace(&root_id).map_err(|error| error.to_string())
    })
}

/// Run the browser authorization flow to completion.  Bounded OAuth reasons
/// are returned directly; they never contain provider bodies or credentials.
#[tauri::command]
async fn connect_linear(host: State<'_, DesktopHost>) -> Result<LinearConnectionView, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    *lock(&host.pending_connect) = Some(cancel.clone());
    let connection = host.connection.clone();
    let result = tauri::async_runtime::spawn_blocking(move || connection.connect(&cancel)).await;
    *lock(&host.pending_connect) = None;
    match result {
        Ok(Ok(view)) => Ok(view),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(OAuthError::Transport.to_string()),
    }
}

#[tauri::command]
fn cancel_linear_connect(host: State<'_, DesktopHost>) {
    if let Some(cancel) = lock(&host.pending_connect).as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn disconnect_linear(host: State<'_, DesktopHost>) -> Result<(), String> {
    host.connection.disconnect().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_linear_projects(host: State<'_, DesktopHost>) -> Result<Vec<LinearProject>, String> {
    let token = host.connection.access_token().map_err(|error| error.to_string())?;
    let adapter = host.projects.as_ref().ok_or_else(fixed_error)?;
    adapter.set_access_token(&token);
    adapter.list_projects().map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir()?;
            app.manage(DesktopHost::initialize(&app_data_directory));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_snapshot,
            upsert_binding,
            delete_binding,
            start_binding,
            stop_binding,
            open_linear,
            open_workspace,
            open_delivery,
            open_diagnostics,
            cleanup_workspace,
            connect_linear,
            cancel_linear_connect,
            disconnect_linear,
            list_linear_projects,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Symphony Podium Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::TransportError;

    fn test_host(runtime: HostRuntime) -> DesktopHost {
        let directory = std::env::temp_dir().join(format!(
            "symphony-host-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        DesktopHost {
            runtime: Mutex::new(runtime),
            connection: Arc::new(TokenProvider::new(&directory, OAuthEndpoints::default())),
            projects: None,
            pending_connect: Mutex::new(None),
        }
    }

    #[test]
    fn unavailable_host_returns_only_the_fixed_reason() {
        let host = test_host(HostRuntime::Unavailable);
        let error = host.with_runtime(|_| Ok(())).unwrap_err();
        assert_eq!(error, "podium_runtime_unavailable");
    }

    #[test]
    fn transport_errors_are_not_part_of_the_host_error() {
        assert_ne!(fixed_error(), TransportError::RequestFailed.to_string());
    }

    #[test]
    fn root_actions_fail_with_bounded_actionable_reasons_until_the_owned_boundary_exists() {
        for (kind, expected) in [
            ("open_linear", "root_open_linear_unavailable"),
            ("open_workspace", "root_open_workspace_unavailable"),
            ("open_delivery", "root_open_delivery_unavailable"),
            ("open_diagnostics", "root_open_diagnostics_unavailable"),
            ("cleanup_workspace", "root_cleanup_workspace_unavailable"),
        ] {
            assert_eq!(root_action_unavailable_reason(kind), expected);
        }
    }

    #[test]
    fn connection_view_never_contains_tokens() {
        let host = test_host(HostRuntime::Unavailable);
        let connection = host.connection.clone();
        let directory = std::env::temp_dir().join(format!(
            "symphony-host-view-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = CredentialStore::new(&directory);
        store
            .replace(
                &StoredCredentials::new("client", "Acme", "access-secret", "refresh-secret", 1)
                    .unwrap(),
            )
            .unwrap();
        drop(store);
        let loaded = TokenProvider::new(&directory, OAuthEndpoints::default());
        let view = loaded.view();
        assert_eq!(view, LinearConnectionView::Connected { organization: "Acme".into() });
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("secret"));
        assert_eq!(connection.view(), LinearConnectionView::Disconnected);
    }
}
