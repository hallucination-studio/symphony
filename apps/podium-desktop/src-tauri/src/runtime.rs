//! Local Podium scheduling and process supervision.
//!
//! The runtime owns only Desktop-local state. Project bindings are loaded from
//! [`JsonStore`]; enabled bindings, assignments, queues, and process handles
//! remain in memory. Root paths are derived by the resource provider for each
//! launch and are never persisted by the runtime.

use crate::domain::{AgentKind, ProjectBinding, RootCandidate};
use crate::launch::{ConductorOutcome, LaunchError, LaunchRequest, RunningConductor};
use crate::resources::RootResources;
use crate::scheduler::{self, CurrentAssignment, ScheduleAction};
use crate::store::{JsonStore, PersistedState};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::Debug;
use std::path::PathBuf;
use std::time::Duration;

/// Podium starts one bounded Conductor invocation for each local assignment.
/// The binding contract intentionally does not carry a cycle limit, so the
/// Desktop uses the architecture's ordinary 30-cycle process bound.
pub const DEFAULT_MAX_CYCLES: u32 = 30;

/// A provider-normalized Root candidate.  `candidate` carries scheduler facts;
/// the two labels are the only operator-facing Root identity retained by the
/// runtime assignment and snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateRecord {
    pub candidate: RootCandidate,
    pub identifier: String,
    pub title: String,
}

impl CandidateRecord {
    pub fn new(
        candidate: RootCandidate,
        identifier: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self { candidate, identifier: identifier.into(), title: title.into() }
    }
}

/// Source of currently eligible Roots for one Project Binding.
///
/// Implementations should normalize external provider responses before they
/// cross this boundary.  Runtime errors are intentionally constrained to the
/// fixed event below; the provider's error value is never displayed or
/// serialized.
pub trait CandidateSource {
    type Error: Debug;

    fn candidates(&mut self, binding: &ProjectBinding)
        -> Result<Vec<CandidateRecord>, Self::Error>;
}

/// Stable workspace/run-directory paths for one candidate Root.
pub trait AllocationProvider {
    type Error: Debug;

    fn allocate(
        &mut self,
        binding: &ProjectBinding,
        candidate: &CandidateRecord,
    ) -> Result<RootResources, Self::Error>;

    /// Remove the derived workspace for a completed Root.  Runtime performs
    /// the status and delivery gate before calling this boundary; providers
    /// remain responsible for validating the exact repository/workspace
    /// relationship.
    fn cleanup_workspace(
        &mut self,
        binding: &ProjectBinding,
        root_id: &str,
    ) -> Result<(), Self::Error>;
}

/// Sanitized terminal result emitted by a bound Conductor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutcome {
    Completed,
    NeedsHuman,
    Failed,
}

impl From<ConductorOutcome> for TerminalOutcome {
    fn from(outcome: ConductorOutcome) -> Self {
        match outcome {
            ConductorOutcome::Completed => Self::Completed,
            ConductorOutcome::NeedsHuman => Self::NeedsHuman,
            ConductorOutcome::Failed => Self::Failed,
        }
    }
}

/// Handle held only in runtime memory.  It is deliberately absent from every
/// public snapshot and persisted record.
pub trait ProcessHandle {
    type Error: Debug;

    /// Stop must return only after the complete process tree is confirmed gone.
    fn stop(&mut self) -> Result<(), Self::Error>;

    /// Return a terminal outcome when the child has exited; `None` means it is
    /// still running.  The default allows a fake to implement the historical
    /// `poll_terminal` spelling while keeping one runtime call site.
    fn try_terminal(&mut self) -> Result<Option<TerminalOutcome>, Self::Error> {
        self.poll_terminal()
    }

    fn poll_terminal(&mut self) -> Result<Option<TerminalOutcome>, Self::Error> {
        Ok(None)
    }
}

/// Injectable process launcher.  The existing [`LaunchRequest`] is the sole
/// launch contract; runtime does not introduce a second request shape.
pub trait ProcessLauncher {
    type Handle: ProcessHandle;
    type Error: Debug;

    fn launch(&mut self, request: &LaunchRequest) -> Result<Self::Handle, Self::Error>;
}

/// Fixed, sanitized event kinds shown to the Desktop operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
    BindingStarted,
    BindingStopped,
    AssignmentStarted,
    AssignmentStopped,
    Terminal,
    CandidateUnavailable,
    AllocationUnavailable,
    LaunchFailed,
    StopFailed,
    ProcessObservationFailed,
    RootConflict,
    AllocationConflict,
    PersistenceFailed,
}

/// A visible event with only normalized identity and fixed reason codes.
/// Provider/process error values never cross into this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEvent {
    pub kind: RuntimeEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TerminalOutcome>,
}

impl RuntimeEvent {
    fn binding(kind: RuntimeEventKind, binding_id: &str) -> Self {
        Self { kind, binding_id: Some(binding_id.to_owned()), root_id: None, outcome: None }
    }

    fn assignment(kind: RuntimeEventKind, assignment: &SlotIdentity) -> Self {
        Self {
            kind,
            binding_id: Some(assignment.binding_id.clone()),
            root_id: Some(assignment.root_id.clone()),
            outcome: None,
        }
    }

    fn terminal(assignment: &SlotIdentity, outcome: TerminalOutcome) -> Self {
        Self {
            kind: RuntimeEventKind::Terminal,
            binding_id: Some(assignment.binding_id.clone()),
            root_id: Some(assignment.root_id.clone()),
            outcome: Some(outcome),
        }
    }
}

/// The closed action vocabulary exposed to the operator surface. Action
/// availability is explicit so an unimplemented native boundary is never a
/// successful no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "snake_case")]
pub enum RootActionKind {
    OpenLinear,
    OpenWorkspace,
    OpenDelivery,
    OpenDiagnostics,
    CleanupWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootActionView {
    pub kind: RootActionKind,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A native target resolved for one Root action.  This value stays inside the
/// Desktop host; paths and URLs never cross the browser snapshot boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RootActionTarget {
    Url(String),
    Path(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootStatus {
    Running,
    Waiting,
    NeedsAttention,
    Completed,
}

/// Serializable Root-centric view. Process handles, allocation paths,
/// credentials, and scheduler slot IDs never cross this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootView {
    pub root_id: String,
    pub binding_id: String,
    pub identifier: String,
    pub title: String,
    pub priority: u8,
    pub status: RootStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<u32>,
    pub observed_at: String,
    pub actions: Vec<RootActionView>,
}

/// Public Desktop projection. Bindings and Root summaries are current state;
/// events are bounded in-memory history and contain no process internals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopSnapshot {
    pub bindings: Vec<ProjectBinding>,
    pub roots: Vec<RootView>,
    pub events: Vec<RuntimeEvent>,
}

/// Sanitized operation errors.  Causal provider/process details stay in local
/// diagnostics owned by their adapter and are never rendered here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeError {
    BindingNotFound,
    InvalidBinding,
    StopFailed,
    PersistenceFailed,
    RootNotFound,
    RootActionUnavailable,
    RootCleanupUnavailable,
    RootCleanupFailed,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::BindingNotFound => "binding_not_found",
            Self::InvalidBinding => "invalid_binding",
            Self::StopFailed => "process_stop_failed",
            Self::PersistenceFailed => "state_persistence_failed",
            Self::RootNotFound => "root_not_found",
            Self::RootActionUnavailable => "root_action_unavailable",
            Self::RootCleanupUnavailable => "root_cleanup_workspace_unavailable",
            Self::RootCleanupFailed => "root_cleanup_workspace_failed",
        };
        formatter.write_str(reason)
    }
}

impl std::error::Error for RuntimeError {}

/// Runtime-owned identity shared by internal assignments and public events.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SlotIdentity {
    slot_id: String,
    binding_id: String,
    root_id: String,
}

struct RunningAssignment<H> {
    identity: SlotIdentity,
    priority: u8,
    identifier: String,
    title: String,
    resources: RootResources,
    process: H,
}

impl<H> RunningAssignment<H> {
    fn current(&self) -> CurrentAssignment {
        CurrentAssignment { root_id: self.identity.root_id.clone(), priority: self.priority }
    }
}

#[derive(Debug, Clone)]
struct RootHistory {
    binding_id: String,
    root_id: String,
    identifier: String,
    title: String,
    resources: RootResources,
    priority: u8,
    status: RootStatus,
    latest_event: Option<String>,
    completed_order: Option<u64>,
    workspace_cleaned: bool,
    retention_attempted: bool,
}

const EVENT_HISTORY_LIMIT: usize = 256;

/// Local scheduler/runtime core.
pub struct Runtime<C, A, L>
where
    C: CandidateSource,
    A: AllocationProvider,
    L: ProcessLauncher,
{
    store: JsonStore,
    persisted: PersistedState,
    candidate_source: C,
    resource_provider: A,
    process_launcher: L,
    enabled_binding_ids: BTreeSet<String>,
    assignments: Vec<RunningAssignment<L::Handle>>,
    candidate_records: BTreeMap<String, Vec<CandidateRecord>>,
    root_history: BTreeMap<String, RootHistory>,
    events: VecDeque<RuntimeEvent>,
    next_slot_number: u64,
    next_completion_order: u64,
}

impl<C, A, L> Runtime<C, A, L>
where
    C: CandidateSource,
    A: AllocationProvider,
    L: ProcessLauncher,
{
    /// Load durable bindings and start with an empty local runtime.
    pub fn new(
        store: JsonStore,
        candidate_source: C,
        allocation_provider: A,
        process_launcher: L,
    ) -> std::io::Result<Self> {
        let persisted = store.load()?;
        Ok(Self::from_persisted(
            store,
            persisted,
            candidate_source,
            allocation_provider,
            process_launcher,
        ))
    }

    /// Construct from already-loaded state; useful for deterministic tests and
    /// startup code that has its own load diagnostics.
    pub fn from_persisted(
        store: JsonStore,
        persisted: PersistedState,
        candidate_source: C,
        allocation_provider: A,
        process_launcher: L,
    ) -> Self {
        Self {
            store,
            persisted,
            candidate_source,
            resource_provider: allocation_provider,
            process_launcher,
            enabled_binding_ids: BTreeSet::new(),
            assignments: Vec::new(),
            candidate_records: BTreeMap::new(),
            root_history: BTreeMap::new(),
            events: VecDeque::new(),
            next_slot_number: 1,
            next_completion_order: 1,
        }
    }

    pub fn persisted_state(&self) -> &PersistedState {
        &self.persisted
    }

    pub fn bindings(&self) -> &[ProjectBinding] {
        &self.persisted.bindings
    }

    pub fn enabled_binding_ids(&self) -> impl Iterator<Item = &str> {
        self.enabled_binding_ids.iter().map(String::as_str)
    }

    pub fn snapshot(&self) -> DesktopSnapshot {
        let observed_at = observed_at();
        DesktopSnapshot {
            bindings: self.persisted.bindings.clone(),
            roots: self.root_views(&observed_at),
            events: self.events.iter().cloned().collect(),
        }
    }

    pub fn desktop_snapshot(&self) -> DesktopSnapshot {
        self.snapshot()
    }

    /// Insert or replace a durable binding.  The project ID is the local
    /// binding identity because `ProjectBinding` deliberately has no second ID.
    pub fn upsert_binding(&mut self, binding: ProjectBinding) -> Result<(), RuntimeError> {
        validate_binding(&binding)?;
        let mut next = self.persisted.clone();
        if let Some(existing) =
            next.bindings.iter_mut().find(|existing| existing.project_id == binding.project_id)
        {
            *existing = binding;
        } else {
            next.bindings.push(binding);
        }
        self.persist(&next)?;
        self.persisted = next;
        Ok(())
    }

    /// Stop every assignment first, then durably remove the binding.  A failed
    /// stop leaves the binding enabled/persisted so no replacement can slip in.
    pub fn delete_binding(&mut self, binding_id: &str) -> Result<(), RuntimeError> {
        self.require_binding(binding_id)?;
        self.stop_assignments_for(binding_id, RuntimeEventKind::AssignmentStopped)?;

        let mut next = self.persisted.clone();
        next.bindings.retain(|binding| binding.project_id != binding_id);
        self.persist(&next)?;
        self.persisted = next;
        self.enabled_binding_ids.remove(binding_id);
        Ok(())
    }

    pub fn start_binding(&mut self, binding_id: &str) -> Result<(), RuntimeError> {
        self.require_binding(binding_id)?;
        if self.enabled_binding_ids.insert(binding_id.to_owned()) {
            self.record(RuntimeEvent::binding(RuntimeEventKind::BindingStarted, binding_id));
        }
        Ok(())
    }

    /// Stop assignments before disabling a binding.  No scheduler action can
    /// launch a replacement after this method returns successfully.
    pub fn stop_binding(&mut self, binding_id: &str) -> Result<(), RuntimeError> {
        self.require_binding(binding_id)?;
        self.stop_assignments_for(binding_id, RuntimeEventKind::AssignmentStopped)?;
        if self.enabled_binding_ids.remove(binding_id) {
            self.record(RuntimeEvent::binding(RuntimeEventKind::BindingStopped, binding_id));
        }
        Ok(())
    }

    /// Explicitly remove a completed Root's derived workspace.  A successful
    /// Conductor `Completed` outcome is the Desktop's only trusted delivery
    /// proof, so active, waiting, and NeedsAttention Roots are rejected before
    /// the provider boundary is reached.
    pub fn cleanup_workspace(&mut self, root_id: &str) -> Result<(), RuntimeError> {
        let Some((binding_id, status, workspace_cleaned)) = self
            .root_history
            .get(root_id)
            .map(|root| (root.binding_id.clone(), root.status, root.workspace_cleaned))
        else {
            let active =
                self.assignments.iter().any(|assignment| assignment.identity.root_id == root_id);
            let waiting = self.candidate_records.values().any(|candidates| {
                candidates.iter().any(|candidate| candidate.candidate.id == root_id)
            });
            return Err(if active || waiting {
                RuntimeError::RootCleanupUnavailable
            } else {
                RuntimeError::RootNotFound
            });
        };
        if status != RootStatus::Completed || workspace_cleaned {
            return Err(RuntimeError::RootCleanupUnavailable);
        }
        let binding = self
            .persisted
            .bindings
            .iter()
            .find(|binding| binding.project_id == binding_id)
            .cloned()
            .ok_or(RuntimeError::RootCleanupUnavailable)?;
        self.resource_provider
            .cleanup_workspace(&binding, root_id)
            .map_err(|_| RuntimeError::RootCleanupFailed)?;
        if let Some(root) = self.root_history.get_mut(root_id) {
            root.workspace_cleaned = true;
        }
        Ok(())
    }

    /// Observe terminal children and perform one scheduling pass per enabled
    /// binding.  Provider failures become visible fixed-kind events and do not
    /// spin/retry inside this call.
    pub fn tick(&mut self) -> Result<(), RuntimeError> {
        let terminal_bindings = self.observe_terminals();
        self.apply_retention();
        let enabled = self.enabled_binding_ids.iter().cloned().collect::<Vec<_>>();
        for binding_id in enabled {
            // A terminal child is released now; defer replacement to the next
            // tick so a static candidate source cannot turn NeedsHuman into an
            // immediate hidden retry.
            if terminal_bindings.contains(&binding_id) {
                continue;
            }
            let Some(binding) = self
                .persisted
                .bindings
                .iter()
                .find(|binding| binding.project_id == binding_id)
                .cloned()
            else {
                // A concurrently deleted binding cannot be scheduled.
                continue;
            };

            let candidates = match self.candidate_source.candidates(&binding) {
                Ok(candidates) => candidates,
                Err(_) => {
                    self.record(RuntimeEvent::binding(
                        RuntimeEventKind::CandidateUnavailable,
                        &binding_id,
                    ));
                    continue;
                }
            };
            self.candidate_records.insert(binding_id.clone(), candidates.clone());
            self.schedule_binding(&binding, candidates)?;
        }
        Ok(())
    }

    fn schedule_binding(
        &mut self,
        binding: &ProjectBinding,
        candidates: Vec<CandidateRecord>,
    ) -> Result<(), RuntimeError> {
        // A stop-only scheduler plan is terminal for this pass.  Once every
        // stop succeeds, call the scheduler again; Start is never interleaved
        // with an unconfirmed stop.
        let max_passes = binding.concurrency as usize + candidates.len() + 1;
        for _ in 0..max_passes {
            let current = self
                .assignments
                .iter()
                .filter(|assignment| assignment.identity.binding_id == binding.project_id)
                .map(RunningAssignment::current)
                .collect::<Vec<_>>();
            let scheduler_candidates =
                candidates.iter().map(|record| record.candidate.clone()).collect::<Vec<_>>();
            let actions = scheduler::schedule(binding, &scheduler_candidates, &current);
            let stop_actions = actions
                .iter()
                .filter_map(|action| match action {
                    ScheduleAction::Stop { assignment } => Some(assignment.root_id.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if !stop_actions.is_empty() {
                let mut all_stopped = true;
                for root_id in stop_actions {
                    if !self.stop_assignment(binding.project_id.as_str(), root_id)? {
                        all_stopped = false;
                    }
                }
                if all_stopped {
                    continue;
                }
                return Ok(());
            }

            for action in actions {
                let ScheduleAction::Start { candidate } = action else {
                    continue;
                };
                let Some(record) =
                    candidates.iter().find(|record| record.candidate.id == candidate.id)
                else {
                    continue;
                };
                self.start_candidate(binding, record)?;
            }
            return Ok(());
        }
        // This is a defensive bound against malformed provider data or a
        // future scheduler cycle; normal plans always return above.
        Ok(())
    }

    fn start_candidate(
        &mut self,
        binding: &ProjectBinding,
        record: &CandidateRecord,
    ) -> Result<(), RuntimeError> {
        let root_id = &record.candidate.id;
        if self.assignments.iter().any(|assignment| assignment.identity.root_id == *root_id) {
            self.record(RuntimeEvent {
                kind: RuntimeEventKind::RootConflict,
                binding_id: Some(binding.project_id.clone()),
                root_id: Some(root_id.clone()),
                outcome: None,
            });
            return Ok(());
        }

        let resources = match self.resource_provider.allocate(binding, record) {
            Ok(resources) => resources,
            Err(_) => {
                self.record(RuntimeEvent {
                    kind: RuntimeEventKind::AllocationUnavailable,
                    binding_id: Some(binding.project_id.clone()),
                    root_id: Some(root_id.clone()),
                    outcome: None,
                });
                return Ok(());
            }
        };

        let request = LaunchRequest::new(
            root_id.clone(),
            PathBuf::from(&binding.repository_path),
            resources.workspace_path.clone(),
            resources.run_directory.clone(),
            DEFAULT_MAX_CYCLES,
            binding.reconcile_config(),
            binding.artist_config(),
            binding.critic_config(),
        );
        let process = match self.process_launcher.launch(&request) {
            Ok(process) => process,
            Err(_) => {
                self.record(RuntimeEvent {
                    kind: RuntimeEventKind::LaunchFailed,
                    binding_id: Some(binding.project_id.clone()),
                    root_id: Some(root_id.clone()),
                    outcome: None,
                });
                return Ok(());
            }
        };

        let slot_id = self.next_slot_id();
        let identity = SlotIdentity {
            slot_id,
            binding_id: binding.project_id.clone(),
            root_id: root_id.clone(),
        };
        let event_identity = identity.clone();
        self.assignments.push(RunningAssignment {
            identity,
            priority: record.candidate.priority,
            identifier: record.identifier.clone(),
            title: record.title.clone(),
            resources,
            process,
        });
        self.record(RuntimeEvent::assignment(RuntimeEventKind::AssignmentStarted, &event_identity));
        Ok(())
    }

    fn observe_terminals(&mut self) -> BTreeSet<String> {
        let mut terminal_bindings = BTreeSet::new();
        let mut index = self.assignments.len();
        while index > 0 {
            index -= 1;
            let result = self.assignments[index].process.try_terminal();
            match result {
                Ok(Some(outcome)) => {
                    let assignment = self.assignments.remove(index);
                    terminal_bindings.insert(assignment.identity.binding_id.clone());
                    let completed_order = if outcome == TerminalOutcome::Completed {
                        let order = self.next_completion_order;
                        self.next_completion_order = self.next_completion_order.saturating_add(1);
                        Some(order)
                    } else {
                        None
                    };
                    self.root_history.insert(
                        assignment.identity.root_id.clone(),
                        RootHistory {
                            binding_id: assignment.identity.binding_id.clone(),
                            root_id: assignment.identity.root_id.clone(),
                            identifier: assignment.identifier.clone(),
                            title: assignment.title.clone(),
                            resources: assignment.resources.clone(),
                            priority: assignment.priority,
                            status: match outcome {
                                TerminalOutcome::Completed => RootStatus::Completed,
                                TerminalOutcome::NeedsHuman | TerminalOutcome::Failed => {
                                    RootStatus::NeedsAttention
                                }
                            },
                            latest_event: Some(match outcome {
                                TerminalOutcome::Completed => "Conductor completed".to_owned(),
                                TerminalOutcome::NeedsHuman => {
                                    "Conductor needs attention".to_owned()
                                }
                                TerminalOutcome::Failed => "Conductor failed".to_owned(),
                            }),
                            completed_order,
                            workspace_cleaned: false,
                            retention_attempted: false,
                        },
                    );
                    self.record(RuntimeEvent::terminal(&assignment.identity, outcome));
                }
                Ok(None) => {}
                Err(_) => {
                    let identity = self.assignments[index].identity.clone();
                    terminal_bindings.insert(identity.binding_id.clone());
                    self.record(RuntimeEvent::assignment(
                        RuntimeEventKind::ProcessObservationFailed,
                        &identity,
                    ));
                }
            }
        }
        terminal_bindings
    }

    /// Apply the optional per-binding retention bound after terminal
    /// observations. Only Roots with the trusted Completed outcome are
    /// candidates, and the newest `retention` entries are always retained.
    /// Provider failures leave the entry visible and eligible for a later
    /// bounded attempt; no workspace is force-removed or hidden.
    fn apply_retention(&mut self) {
        let bindings = self
            .persisted
            .bindings
            .iter()
            .filter_map(|binding| {
                binding
                    .completed_workspace_retention
                    .map(|retention| (binding.project_id.clone(), retention))
            })
            .collect::<Vec<_>>();
        for (binding_id, retention) in bindings {
            let mut completed = self
                .root_history
                .values()
                .filter(|root| {
                    root.binding_id == binding_id
                        && root.status == RootStatus::Completed
                        && !root.workspace_cleaned
                        && !root.retention_attempted
                })
                .map(|root| (root.root_id.clone(), root.completed_order.unwrap_or(u64::MAX)))
                .collect::<Vec<_>>();
            completed.sort_by_key(|(_, order)| *order);
            let remove_count = completed.len().saturating_sub(retention as usize);
            for (root_id, _) in completed.into_iter().take(remove_count) {
                if let Some(root) = self.root_history.get_mut(&root_id) {
                    root.retention_attempted = true;
                }
                let _ = self.cleanup_workspace(&root_id);
            }
        }
    }

    fn stop_assignments_for(
        &mut self,
        binding_id: &str,
        event_kind: RuntimeEventKind,
    ) -> Result<(), RuntimeError> {
        let roots = self
            .assignments
            .iter()
            .filter(|assignment| assignment.identity.binding_id == binding_id)
            .map(|assignment| assignment.identity.root_id.clone())
            .collect::<Vec<_>>();
        let mut failed = false;
        for root_id in roots {
            if !self.stop_assignment_with_event(binding_id, &root_id, event_kind)? {
                failed = true;
            }
        }
        if failed {
            Err(RuntimeError::StopFailed)
        } else {
            Ok(())
        }
    }

    fn stop_assignment(&mut self, binding_id: &str, root_id: &str) -> Result<bool, RuntimeError> {
        self.stop_assignment_with_event(binding_id, root_id, RuntimeEventKind::AssignmentStopped)
    }

    fn stop_assignment_with_event(
        &mut self,
        binding_id: &str,
        root_id: &str,
        event_kind: RuntimeEventKind,
    ) -> Result<bool, RuntimeError> {
        let Some(index) = self.assignments.iter().position(|assignment| {
            assignment.identity.binding_id == binding_id && assignment.identity.root_id == root_id
        }) else {
            return Ok(true);
        };
        let stop_result = self.assignments[index].process.stop();
        if stop_result.is_err() {
            let identity = self.assignments[index].identity.clone();
            self.record(RuntimeEvent::assignment(RuntimeEventKind::StopFailed, &identity));
            return Ok(false);
        }
        let assignment = self.assignments.remove(index);
        self.record(RuntimeEvent::assignment(event_kind, &assignment.identity));
        Ok(true)
    }

    fn next_slot_id(&mut self) -> String {
        let slot_id = format!("slot-{}", self.next_slot_number);
        self.next_slot_number = self.next_slot_number.saturating_add(1);
        slot_id
    }

    fn root_views(&self, observed_at: &str) -> Vec<RootView> {
        let assigned = self
            .assignments
            .iter()
            .map(|assignment| assignment.identity.root_id.as_str())
            .collect::<BTreeSet<_>>();
        let mut roots = self
            .assignments
            .iter()
            .map(|assignment| RootView {
                root_id: assignment.identity.root_id.clone(),
                binding_id: assignment.identity.binding_id.clone(),
                identifier: assignment.identifier.clone(),
                title: assignment.title.clone(),
                priority: assignment.priority,
                status: RootStatus::Running,
                latest_event: Some("Conductor is running".to_owned()),
                queue_position: None,
                observed_at: observed_at.to_owned(),
                actions: root_actions(RootStatus::Running, false, Some(&assignment.resources)),
            })
            .collect::<Vec<_>>();

        roots.extend(
            self.root_history
                .values()
                .filter(|root| !assigned.contains(root.root_id.as_str()))
                .map(|root| RootView {
                    root_id: root.root_id.clone(),
                    binding_id: root.binding_id.clone(),
                    identifier: root.identifier.clone(),
                    title: root.title.clone(),
                    priority: root.priority,
                    status: root.status,
                    latest_event: root.latest_event.clone(),
                    queue_position: None,
                    observed_at: observed_at.to_owned(),
                    actions: root_actions(
                        root.status,
                        root.workspace_cleaned,
                        Some(&root.resources),
                    ),
                }),
        );

        for binding_id in &self.enabled_binding_ids {
            let Some(candidates) = self.candidate_records.get(binding_id) else {
                continue;
            };
            let mut waiting = candidates.clone();
            waiting.sort_by(compare_candidate_records);
            let mut queue_position = 0_u32;
            for candidate in waiting {
                if assigned.contains(candidate.candidate.id.as_str())
                    || self.root_history.contains_key(&candidate.candidate.id)
                {
                    continue;
                }
                queue_position = queue_position.saturating_add(1);
                roots.push(RootView {
                    root_id: candidate.candidate.id,
                    binding_id: binding_id.clone(),
                    identifier: candidate.identifier,
                    title: candidate.title,
                    priority: candidate.candidate.priority,
                    status: RootStatus::Waiting,
                    latest_event: Some("Waiting for capacity".to_owned()),
                    queue_position: Some(queue_position),
                    observed_at: observed_at.to_owned(),
                    actions: root_actions(RootStatus::Waiting, false, None),
                });
            }
        }

        roots.sort_by(|left, right| {
            root_status_rank(left.status)
                .cmp(&root_status_rank(right.status))
                .then_with(|| left.priority.cmp(&right.priority))
                .then_with(|| left.root_id.cmp(&right.root_id))
        });
        roots
    }

    /// Resolve a native target from the runtime's current Root view.  Resource
    /// paths are retained only in memory after allocation, so this lookup never
    /// creates directories or writes durable state.
    pub(crate) fn root_action_target(
        &self,
        root_id: &str,
        kind: RootActionKind,
    ) -> Result<RootActionTarget, RuntimeError> {
        let Some((status, workspace_cleaned, identifier, resources)) = self
            .assignments
            .iter()
            .find(|assignment| assignment.identity.root_id == root_id)
            .map(|assignment| {
                (
                    RootStatus::Running,
                    false,
                    assignment.identifier.clone(),
                    Some(assignment.resources.clone()),
                )
            })
            .or_else(|| {
                self.root_history.get(root_id).map(|root| {
                    (
                        root.status,
                        root.workspace_cleaned,
                        root.identifier.clone(),
                        Some(root.resources.clone()),
                    )
                })
            })
            .or_else(|| {
                self.candidate_records.values().find_map(|candidates| {
                    candidates.iter().find(|candidate| candidate.candidate.id == root_id).map(
                        |candidate| {
                            (RootStatus::Waiting, false, candidate.identifier.clone(), None)
                        },
                    )
                })
            })
        else {
            return Err(RuntimeError::RootNotFound);
        };

        let issue_url = || {
            (!identifier.trim().is_empty()
                && !identifier.chars().any(|character| matches!(character, '\0' | '\r' | '\n')))
            .then(|| RootActionTarget::Url(format!("https://linear.app/issue/{identifier}")))
            .ok_or(RuntimeError::RootActionUnavailable)
        };

        match kind {
            RootActionKind::OpenLinear => issue_url(),
            RootActionKind::OpenDelivery if status == RootStatus::Completed => issue_url(),
            RootActionKind::OpenDelivery => Err(RuntimeError::RootActionUnavailable),
            RootActionKind::OpenWorkspace => {
                let Some(resources) = resources else {
                    return Err(RuntimeError::RootActionUnavailable);
                };
                if workspace_cleaned || !resources.workspace_path.is_dir() {
                    return Err(RuntimeError::RootActionUnavailable);
                }
                Ok(RootActionTarget::Path(resources.workspace_path))
            }
            RootActionKind::OpenDiagnostics => {
                let Some(resources) = resources else {
                    return Err(RuntimeError::RootActionUnavailable);
                };
                if !resources.run_directory.is_dir() {
                    return Err(RuntimeError::RootActionUnavailable);
                }
                Ok(RootActionTarget::Path(resources.run_directory))
            }
            RootActionKind::CleanupWorkspace => Err(RuntimeError::RootActionUnavailable),
        }
    }

    fn require_binding(&self, binding_id: &str) -> Result<(), RuntimeError> {
        self.persisted
            .bindings
            .iter()
            .any(|binding| binding.project_id == binding_id)
            .then_some(())
            .ok_or(RuntimeError::BindingNotFound)
    }

    fn persist(&self, next: &PersistedState) -> Result<(), RuntimeError> {
        self.store.replace(next).map_err(|_| RuntimeError::PersistenceFailed)
    }

    fn record(&mut self, event: RuntimeEvent) {
        if self.events.len() == EVENT_HISTORY_LIMIT {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
}

impl ProcessHandle for RunningConductor {
    type Error = LaunchError;

    fn stop(&mut self) -> Result<(), Self::Error> {
        self.stop(Duration::from_secs(10)).map(|_| ())
    }

    fn try_terminal(&mut self) -> Result<Option<TerminalOutcome>, Self::Error> {
        self.try_observe().map(|observation| observation.map(|value| value.outcome.into()))
    }
}

fn root_actions(
    status: RootStatus,
    workspace_cleaned: bool,
    resources: Option<&RootResources>,
) -> Vec<RootActionView> {
    let workspace_available =
        !workspace_cleaned && resources.is_some_and(|resources| resources.workspace_path.is_dir());
    let diagnostics_available = resources.is_some_and(|resources| resources.run_directory.is_dir());
    let availability = [
        (RootActionKind::OpenLinear, true),
        (RootActionKind::OpenWorkspace, workspace_available),
        (RootActionKind::OpenDelivery, status == RootStatus::Completed),
        (RootActionKind::OpenDiagnostics, diagnostics_available),
        (RootActionKind::CleanupWorkspace, status == RootStatus::Completed && !workspace_cleaned),
    ];
    availability
        .into_iter()
        .map(|(kind, available)| RootActionView {
            kind,
            available,
            reason: (!available).then_some(
                match kind {
                    RootActionKind::OpenLinear => "root_open_linear_unavailable",
                    RootActionKind::OpenWorkspace => "root_open_workspace_unavailable",
                    RootActionKind::OpenDelivery => "root_open_delivery_unavailable",
                    RootActionKind::OpenDiagnostics => "root_open_diagnostics_unavailable",
                    RootActionKind::CleanupWorkspace => "root_cleanup_workspace_unavailable",
                }
                .to_owned(),
            ),
        })
        .collect()
}

fn root_status_rank(status: RootStatus) -> u8 {
    match status {
        RootStatus::Running => 0,
        RootStatus::Waiting => 1,
        RootStatus::NeedsAttention => 2,
        RootStatus::Completed => 3,
    }
}

fn compare_candidate_records(
    left: &CandidateRecord,
    right: &CandidateRecord,
) -> std::cmp::Ordering {
    fn priority_rank(priority: u8) -> u8 {
        match priority {
            1..=4 => priority,
            0 => 5,
            _ => 6,
        }
    }

    priority_rank(left.candidate.priority)
        .cmp(&priority_rank(right.candidate.priority))
        .then_with(|| left.candidate.created_at.cmp(&right.candidate.created_at))
        .then_with(|| left.candidate.id.cmp(&right.candidate.id))
}

fn observed_at() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60
    )
}

// Howard Hinnant's public-domain civil date conversion, kept local so the
// public snapshot can carry RFC3339 timestamps without another dependency.
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn validate_binding(binding: &ProjectBinding) -> Result<(), RuntimeError> {
    if binding.project_id.trim().is_empty()
        || binding.routing_label.trim().is_empty()
        || binding.repository_path.trim().is_empty()
        || binding.base_branch.trim().is_empty()
        || binding.concurrency == 0
        || binding.reconcile_agent != AgentKind::Codex
        || binding.artist_agent != AgentKind::Codex
        || binding.critic_agent != AgentKind::Codex
    {
        Err(RuntimeError::InvalidBinding)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Debug, Clone)]
    struct FakeSource {
        values: HashMap<String, Vec<CandidateRecord>>,
    }

    impl CandidateSource for FakeSource {
        type Error = &'static str;

        fn candidates(
            &mut self,
            binding: &ProjectBinding,
        ) -> Result<Vec<CandidateRecord>, Self::Error> {
            Ok(self.values.get(&binding.project_id).cloned().unwrap_or_default())
        }
    }

    #[derive(Debug, Clone)]
    struct FakeAllocation {
        paths: HashMap<String, RootResources>,
        cleanup_calls: Rc<RefCell<Vec<(String, String)>>>,
        cleanup_ok: bool,
    }

    impl AllocationProvider for FakeAllocation {
        type Error = &'static str;

        fn allocate(
            &mut self,
            _binding: &ProjectBinding,
            candidate: &CandidateRecord,
        ) -> Result<RootResources, Self::Error> {
            self.paths.get(&candidate.candidate.id).cloned().ok_or("missing resources")
        }

        fn cleanup_workspace(
            &mut self,
            binding: &ProjectBinding,
            root_id: &str,
        ) -> Result<(), Self::Error> {
            self.cleanup_calls.borrow_mut().push((binding.project_id.clone(), root_id.to_owned()));
            self.cleanup_ok.then_some(()).ok_or("cleanup failed")
        }
    }

    #[derive(Debug)]
    struct FakeProcess {
        stopped: Rc<RefCell<Vec<String>>>,
        id: String,
        terminal: Option<TerminalOutcome>,
        stop_ok: bool,
    }

    impl ProcessHandle for FakeProcess {
        type Error = &'static str;

        fn stop(&mut self) -> Result<(), Self::Error> {
            if !self.stop_ok {
                return Err("stop failed");
            }
            self.stopped.borrow_mut().push(self.id.clone());
            Ok(())
        }

        fn try_terminal(&mut self) -> Result<Option<TerminalOutcome>, Self::Error> {
            Ok(self.terminal.take())
        }
    }

    #[derive(Debug, Clone)]
    struct FakeLauncher {
        stopped: Rc<RefCell<Vec<String>>>,
        launches: Rc<RefCell<Vec<LaunchRequest>>>,
        stop_ok: bool,
    }

    impl ProcessLauncher for FakeLauncher {
        type Handle = FakeProcess;
        type Error = &'static str;

        fn launch(&mut self, request: &LaunchRequest) -> Result<Self::Handle, Self::Error> {
            self.launches.borrow_mut().push(request.clone());
            Ok(FakeProcess {
                stopped: Rc::clone(&self.stopped),
                id: request.root.clone(),
                terminal: None,
                stop_ok: self.stop_ok,
            })
        }
    }

    type FixtureRuntime = Runtime<FakeSource, FakeAllocation, FakeLauncher>;
    type FixtureResult = (
        FixtureRuntime,
        Rc<RefCell<Vec<String>>>,
        Rc<RefCell<Vec<LaunchRequest>>>,
        std::path::PathBuf,
    );

    fn state_path(label: &str) -> (JsonStore, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "symphony-runtime-{label}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (JsonStore::new(directory.join("state.json")), directory)
    }

    fn binding(id: &str, concurrency: u32) -> ProjectBinding {
        ProjectBinding {
            project_id: id.into(),
            routing_label: id.into(),
            repository_path: format!("/repo/{id}"),
            base_branch: "main".into(),
            concurrency,
            completed_workspace_retention: None,
            reconcile_agent: AgentKind::Codex,
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            artist_agent: AgentKind::Codex,
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: AgentKind::Codex,
            critic_model: None,
            critic_reasoning_effort: None,
        }
    }

    fn candidate(id: &str, priority: u8) -> CandidateRecord {
        CandidateRecord::new(
            RootCandidate { id: id.into(), priority, created_at: format!("2024-01-{priority:02}") },
            format!("{id}-identifier"),
            format!("Root {id}"),
        )
    }

    fn resources(id: &str) -> RootResources {
        RootResources {
            workspace_path: format!("/workspace/{id}").into(),
            run_directory: format!("/run/{id}").into(),
        }
    }

    fn runtime(
        bindings: &[ProjectBinding],
        candidates: HashMap<String, Vec<CandidateRecord>>,
    ) -> FixtureResult {
        let (store, directory) = state_path("fixture");
        let source = FakeSource { values: candidates };
        let paths = bindings
            .iter()
            .flat_map(|binding| {
                source.values.get(&binding.project_id).into_iter().flatten().map(|candidate| {
                    (candidate.candidate.id.clone(), resources(&candidate.candidate.id))
                })
            })
            .collect();
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let launches = Rc::new(RefCell::new(Vec::new()));
        let mut runtime = Runtime::new(
            store,
            source,
            FakeAllocation {
                paths,
                cleanup_calls: Rc::new(RefCell::new(Vec::new())),
                cleanup_ok: true,
            },
            FakeLauncher {
                stopped: Rc::clone(&stopped),
                launches: Rc::clone(&launches),
                stop_ok: true,
            },
        )
        .unwrap();
        for binding in bindings {
            runtime.upsert_binding(binding.clone()).unwrap();
        }
        (runtime, stopped, launches, directory)
    }

    #[test]
    fn schedules_two_bindings_across_multiple_slots() {
        let first = binding("project-a", 2);
        let second = binding("project-b", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("A-1", 1), candidate("A-2", 2)]);
        candidates.insert("project-b".into(), vec![candidate("B-1", 1)]);
        let (mut runtime, _, launches, directory) = runtime(&[first, second], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.start_binding("project-b").unwrap();
        runtime.tick().unwrap();
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.roots.len(), 3);
        assert_eq!(launches.borrow().len(), 3);
        assert!(launches.borrow().iter().all(|request| request.max_cycles == DEFAULT_MAX_CYCLES));
        assert_eq!(snapshot.roots[0].identifier, "A-1-identifier");
        assert!(snapshot.roots.iter().all(|root| !root.root_id.is_empty()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn higher_priority_waiting_root_does_not_preempt_running_root() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("low", 3)]);
        let (mut runtime, stopped, launches, directory) =
            runtime(std::slice::from_ref(&binding), candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        assert_eq!(launches.borrow().len(), 1);

        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("high", 1)]);
        runtime.resource_provider.paths.insert("high".into(), resources("high"));
        runtime.tick().unwrap();
        assert!(stopped.borrow().is_empty());
        assert_eq!(launches.borrow().len(), 1);

        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("equal", 1)]);
        runtime.tick().unwrap();
        assert!(stopped.borrow().is_empty());
        assert_eq!(launches.borrow().len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn delete_stops_assignment_before_persisting_binding_removal() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, stopped, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.delete_binding("project-a").unwrap();
        assert_eq!(stopped.borrow().as_slice(), ["root"]);
        assert!(runtime.bindings().is_empty());
        assert!(runtime.snapshot().roots.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restart_launches_with_the_same_provider_derived_paths_without_persisting_resources() {
        let binding = binding("project-a", 1);
        let record = candidate("root", 1);
        let stable = resources("root");
        let (store, directory) = state_path("derived-resources");
        let launches = Rc::new(RefCell::new(Vec::new()));
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let source = FakeSource {
            values: HashMap::from([(binding.project_id.clone(), vec![record.clone()])]),
        };
        let mut runtime = Runtime::from_persisted(
            store,
            PersistedState { bindings: vec![binding.clone()] },
            source,
            FakeAllocation {
                paths: HashMap::from([(String::from("root"), stable.clone())]),
                cleanup_calls: Rc::new(RefCell::new(Vec::new())),
                cleanup_ok: true,
            },
            FakeLauncher { stopped, launches: Rc::clone(&launches), stop_ok: true },
        );
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        assert_eq!(launches.borrow().len(), 1);
        assert_eq!(runtime.persisted_state(), &PersistedState { bindings: vec![binding.clone()] });
        let state_json = std::fs::read_to_string(runtime.store.path()).unwrap_or_default();
        assert!(!state_json.contains("allocations"));
        assert_eq!(launches.borrow()[0].workspace, stable.workspace_path);
        assert_eq!(launches.borrow()[0].run_directory, stable.run_directory);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn terminal_outcome_releases_slot_without_special_needs_human_retry() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::NeedsHuman);
        runtime.tick().unwrap();
        let snapshot = runtime.snapshot();
        let root = snapshot.roots.first().expect("needs-attention root remains visible");
        assert_eq!(root.status, RootStatus::NeedsAttention);
        assert!(root
            .actions
            .iter()
            .find(|action| action.kind == RootActionKind::CleanupWorkspace)
            .is_some_and(|action| !action.available));
        let events = snapshot.events;
        assert!(events.iter().any(|event| {
            event.kind == RuntimeEventKind::Terminal
                && event.outcome == Some(TerminalOutcome::NeedsHuman)
        }));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn snapshot_does_not_serialize_process_handles_or_secrets() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        let encoded = serde_json::to_string(&runtime.snapshot()).unwrap();
        assert!(encoded.contains("roots"));
        assert!(!encoded.contains("slots"));
        assert!(!encoded.contains("slot_id"));
        assert!(!encoded.contains("workspace_path"));
        assert!(!encoded.contains("run_directory"));
        assert!(!encoded.contains("process"));
        assert!(!encoded.contains("pid"));
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("rawenv"));
        assert!(!encoded.contains("stopped"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn root_snapshot_contains_status_and_closed_action_capabilities() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();

        let snapshot = runtime.snapshot();
        let root = snapshot.roots.first().expect("running root should be visible");
        assert_eq!(root.root_id, "root");
        assert_eq!(root.status, RootStatus::Running);
        assert_eq!(root.queue_position, None);
        assert_eq!(
            root.actions.iter().map(|action| action.kind).collect::<Vec<_>>(),
            vec![
                RootActionKind::OpenLinear,
                RootActionKind::OpenWorkspace,
                RootActionKind::OpenDelivery,
                RootActionKind::OpenDiagnostics,
                RootActionKind::CleanupWorkspace,
            ]
        );
        assert!(root
            .actions
            .iter()
            .find(|action| action.kind == RootActionKind::OpenLinear)
            .is_some_and(|action| action.available && action.reason.is_none()));
        assert!(root
            .actions
            .iter()
            .filter(|action| action.kind != RootActionKind::OpenLinear)
            .all(|action| !action.available && action.reason.is_some()));
        assert_eq!(
            runtime.root_action_target("root", RootActionKind::OpenLinear),
            Ok(RootActionTarget::Url("https://linear.app/issue/root-identifier".into()))
        );
        assert_eq!(
            runtime.root_action_target("root", RootActionKind::OpenDelivery),
            Err(RuntimeError::RootActionUnavailable)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn completed_root_can_open_delivery_without_exposing_local_paths() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();

        assert_eq!(
            runtime.root_action_target("root", RootActionKind::OpenDelivery),
            Ok(RootActionTarget::Url("https://linear.app/issue/root-identifier".into()))
        );
        let snapshot = runtime.snapshot();
        let root = snapshot.roots.first().expect("completed root should be visible");
        assert!(root
            .actions
            .iter()
            .find(|action| action.kind == RootActionKind::OpenDelivery)
            .is_some_and(|action| action.available && action.reason.is_none()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn completed_root_exposes_cleanup_and_marks_it_consumed_after_success() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("root", 1)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();

        let snapshot = runtime.snapshot();
        let root = snapshot.roots.first().expect("completed root should be visible");
        let cleanup = root
            .actions
            .iter()
            .find(|action| action.kind == RootActionKind::CleanupWorkspace)
            .expect("cleanup action should be projected");
        assert!(cleanup.available);
        assert_eq!(cleanup.reason, None);

        runtime.cleanup_workspace("root").unwrap();
        assert_eq!(
            runtime.resource_provider.cleanup_calls.borrow().as_slice(),
            [("project-a".to_owned(), "root".to_owned())]
        );
        assert_eq!(runtime.cleanup_workspace("root"), Err(RuntimeError::RootCleanupUnavailable));
        let snapshot = runtime.snapshot();
        let root = snapshot.roots.first().expect("completed root should remain visible");
        let cleanup = root
            .actions
            .iter()
            .find(|action| action.kind == RootActionKind::CleanupWorkspace)
            .unwrap();
        assert!(!cleanup.available);
        assert_eq!(cleanup.reason.as_deref(), Some("root_cleanup_workspace_unavailable"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cleanup_rejects_running_waiting_and_undelivered_roots() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates
            .insert("project-a".into(), vec![candidate("running", 1), candidate("waiting", 2)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        assert_eq!(runtime.cleanup_workspace("running"), Err(RuntimeError::RootCleanupUnavailable));
        assert_eq!(runtime.cleanup_workspace("waiting"), Err(RuntimeError::RootCleanupUnavailable));

        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Failed);
        runtime.tick().unwrap();
        assert_eq!(runtime.cleanup_workspace("running"), Err(RuntimeError::RootCleanupUnavailable));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retention_attempts_only_older_completed_roots() {
        let mut binding = binding("project-a", 1);
        binding.completed_workspace_retention = Some(1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("first", 1), candidate("second", 2)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();
        assert!(runtime.resource_provider.cleanup_calls.borrow().is_empty());

        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("second", 2)]);
        runtime.tick().unwrap();
        assert_eq!(runtime.assignments[0].identity.root_id, "second");
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();
        assert_eq!(
            runtime.resource_provider.cleanup_calls.borrow().as_slice(),
            [("project-a".to_owned(), "first".to_owned())]
        );
        let roots = runtime.snapshot().roots;
        let first = roots.iter().find(|root| root.root_id == "first").unwrap();
        let second = roots.iter().find(|root| root.root_id == "second").unwrap();
        assert!(
            !first
                .actions
                .iter()
                .find(|action| action.kind == RootActionKind::CleanupWorkspace)
                .unwrap()
                .available
        );
        assert!(
            second
                .actions
                .iter()
                .find(|action| action.kind == RootActionKind::CleanupWorkspace)
                .unwrap()
                .available
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_retention_attempt_is_not_retried_by_later_ticks() {
        let mut binding = binding("project-a", 1);
        binding.completed_workspace_retention = Some(1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("first", 1), candidate("second", 2)]);
        let (mut runtime, _, _, directory) = runtime(&[binding], candidates);
        runtime.resource_provider.cleanup_ok = false;
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();
        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("second", 2)]);
        runtime.tick().unwrap();
        runtime.assignments[0].process.terminal = Some(TerminalOutcome::Completed);
        runtime.tick().unwrap();
        assert_eq!(runtime.resource_provider.cleanup_calls.borrow().len(), 1);

        runtime.tick().unwrap();
        assert_eq!(runtime.resource_provider.cleanup_calls.borrow().len(), 1);
        assert_eq!(runtime.cleanup_workspace("first"), Err(RuntimeError::RootCleanupFailed));
        assert_eq!(runtime.resource_provider.cleanup_calls.borrow().len(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
