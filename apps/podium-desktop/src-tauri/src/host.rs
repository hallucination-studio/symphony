use crate::domain::{ProjectBinding, RootAllocation};
use crate::launch::{ConductorLauncher, LaunchError, LaunchRequest, RunningConductor};
use crate::linear::{LinearCandidateAdapter, LinearError, ReqwestLinearTransport};
use crate::resources::{ResourceError, RootResourceAllocator};
use crate::runtime::{
    AllocationProvider, CandidateRecord, CandidateSource, DesktopSnapshot, ProcessLauncher, Runtime,
};
use crate::store::JsonStore;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

struct LinearCandidates(LinearCandidateAdapter<ReqwestLinearTransport>);

impl CandidateSource for LinearCandidates {
    type Error = LinearError;

    fn candidates(
        &mut self,
        binding: &ProjectBinding,
    ) -> Result<Vec<CandidateRecord>, Self::Error> {
        self.0.list_root_candidates(binding).map(|roots| {
            roots
                .into_iter()
                .map(|root| {
                    CandidateRecord::new(root.to_root_candidate(), root.identifier, root.title)
                })
                .collect()
        })
    }
}

struct RootAllocations(RootResourceAllocator);

impl AllocationProvider for RootAllocations {
    type Error = ResourceError;

    fn allocate(
        &mut self,
        binding: &ProjectBinding,
        candidate: &CandidateRecord,
        existing: Option<&RootAllocation>,
    ) -> Result<RootAllocation, Self::Error> {
        self.0.allocate(binding, &candidate.candidate.id, existing)
    }
}

struct LocalProcesses(ConductorLauncher);

impl ProcessLauncher for LocalProcesses {
    type Handle = RunningConductor;
    type Error = LaunchError;

    fn launch(&mut self, request: &LaunchRequest) -> Result<Self::Handle, Self::Error> {
        self.0.launch(request)
    }
}

type LocalRuntime = Runtime<LinearCandidates, RootAllocations, LocalProcesses>;

enum HostRuntime {
    Ready(Box<LocalRuntime>),
    Unavailable,
}

pub struct DesktopHost {
    runtime: Mutex<HostRuntime>,
}

impl DesktopHost {
    fn initialize(app_data_directory: &Path) -> Self {
        let runtime = create_runtime(app_data_directory)
            .map(Box::new)
            .map(HostRuntime::Ready)
            .unwrap_or(HostRuntime::Unavailable);
        Self { runtime: Mutex::new(runtime) }
    }

    fn with_runtime<T>(
        &self,
        operation: impl FnOnce(&mut LocalRuntime) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.runtime.lock().map_err(|_| fixed_error())?;
        match &mut *state {
            HostRuntime::Ready(runtime) => operation(runtime),
            HostRuntime::Unavailable => Err(fixed_error()),
        }
    }
}

fn fixed_error() -> String {
    "podium_runtime_unavailable".to_owned()
}

fn create_runtime(app_data_directory: &Path) -> Result<LocalRuntime, ()> {
    let data_root = app_data_directory.join("podium");
    std::fs::create_dir_all(&data_root).map_err(|_| ())?;
    let transport = ReqwestLinearTransport::new(Duration::from_secs(15)).map_err(|_| ())?;
    let candidates = LinearCandidateAdapter::from_environment(transport).map_err(|_| ())?;
    Runtime::new(
        JsonStore::new(data_root.join("state.json")),
        LinearCandidates(candidates),
        RootAllocations(RootResourceAllocator::new(&data_root)),
        LocalProcesses(ConductorLauncher::from_environment()),
    )
    .map_err(|_| ())
}

#[tauri::command]
fn get_desktop_snapshot(host: State<'_, DesktopHost>) -> Result<DesktopSnapshot, String> {
    host.with_runtime(|runtime| {
        runtime.tick().map_err(|_| fixed_error())?;
        Ok(runtime.snapshot())
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

pub fn run() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Symphony Podium Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::TransportError;

    #[test]
    fn unavailable_host_returns_only_the_fixed_reason() {
        let host = DesktopHost { runtime: Mutex::new(HostRuntime::Unavailable) };
        let error = host.with_runtime(|_| Ok(())).unwrap_err();
        assert_eq!(error, "podium_runtime_unavailable");
    }

    #[test]
    fn transport_errors_are_not_part_of_the_host_error() {
        assert_ne!(fixed_error(), TransportError::RequestFailed.to_string());
    }
}
