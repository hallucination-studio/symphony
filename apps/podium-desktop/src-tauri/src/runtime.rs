//! Local Podium scheduling and process supervision.
//!
//! The runtime owns only Desktop-local state.  Project bindings and stable
//! allocations are loaded from [`JsonStore`]; enabled bindings, assignments,
//! queues, and process handles remain in memory.  Provider and process
//! boundaries are deliberately small so Linear, resource allocation, and the
//! real Conductor launcher can be wired without changing scheduling policy.

use crate::domain::{ProjectBinding, RootAllocation, RootCandidate};
use crate::launch::{ConductorOutcome, LaunchError, LaunchRequest, RunningConductor};
use crate::scheduler::{self, CurrentAssignment, ScheduleAction};
use crate::store::{JsonStore, PersistedState};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
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

/// Stable workspace/run-directory allocation for one candidate Root.
pub trait AllocationProvider {
    type Error: Debug;

    fn allocate(
        &mut self,
        binding: &ProjectBinding,
        candidate: &CandidateRecord,
        existing: Option<&RootAllocation>,
    ) -> Result<RootAllocation, Self::Error>;
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
    pub slot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TerminalOutcome>,
}

impl RuntimeEvent {
    fn binding(kind: RuntimeEventKind, binding_id: &str) -> Self {
        Self {
            kind,
            binding_id: Some(binding_id.to_owned()),
            slot_id: None,
            root_id: None,
            outcome: None,
        }
    }

    fn assignment(kind: RuntimeEventKind, assignment: &SlotIdentity) -> Self {
        Self {
            kind,
            binding_id: Some(assignment.binding_id.clone()),
            slot_id: Some(assignment.slot_id.clone()),
            root_id: Some(assignment.root_id.clone()),
            outcome: None,
        }
    }

    fn terminal(assignment: &SlotIdentity, outcome: TerminalOutcome) -> Self {
        Self {
            kind: RuntimeEventKind::Terminal,
            binding_id: Some(assignment.binding_id.clone()),
            slot_id: Some(assignment.slot_id.clone()),
            root_id: Some(assignment.root_id.clone()),
            outcome: Some(outcome),
        }
    }
}

/// Serializable view of one running slot.  There is intentionally no process
/// handle, PID, command line, environment, or credential field here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotSnapshot {
    pub slot_id: String,
    pub binding_id: String,
    pub root_id: String,
    pub priority: u8,
    pub identifier: String,
    pub title: String,
}

pub type DesktopSlot = SlotSnapshot;

/// Public Desktop projection.  Bindings and slots are current state; events
/// are bounded in-memory history and contain no process internals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopSnapshot {
    pub bindings: Vec<ProjectBinding>,
    pub slots: Vec<SlotSnapshot>,
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
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::BindingNotFound => "binding_not_found",
            Self::InvalidBinding => "invalid_binding",
            Self::StopFailed => "process_stop_failed",
            Self::PersistenceFailed => "state_persistence_failed",
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
    process: H,
}

impl<H> RunningAssignment<H> {
    fn current(&self) -> CurrentAssignment {
        CurrentAssignment { root_id: self.identity.root_id.clone(), priority: self.priority }
    }

    fn snapshot(&self) -> SlotSnapshot {
        SlotSnapshot {
            slot_id: self.identity.slot_id.clone(),
            binding_id: self.identity.binding_id.clone(),
            root_id: self.identity.root_id.clone(),
            priority: self.priority,
            identifier: self.identifier.clone(),
            title: self.title.clone(),
        }
    }
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
    allocation_provider: A,
    process_launcher: L,
    enabled_binding_ids: BTreeSet<String>,
    assignments: Vec<RunningAssignment<L::Handle>>,
    events: VecDeque<RuntimeEvent>,
    next_slot_number: u64,
}

impl<C, A, L> Runtime<C, A, L>
where
    C: CandidateSource,
    A: AllocationProvider,
    L: ProcessLauncher,
{
    /// Load durable bindings/allocations and start with an empty local runtime.
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
            allocation_provider,
            process_launcher,
            enabled_binding_ids: BTreeSet::new(),
            assignments: Vec::new(),
            events: VecDeque::new(),
            next_slot_number: 1,
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
        DesktopSnapshot {
            bindings: self.persisted.bindings.clone(),
            slots: self.assignments.iter().map(RunningAssignment::snapshot).collect(),
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

    /// Observe terminal children and perform one scheduling pass per enabled
    /// binding.  Provider failures become visible fixed-kind events and do not
    /// spin/retry inside this call.
    pub fn tick(&mut self) -> Result<(), RuntimeError> {
        let terminal_bindings = self.observe_terminals();
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
                slot_id: None,
                root_id: Some(root_id.clone()),
                outcome: None,
            });
            return Ok(());
        }

        let existing = self
            .persisted
            .allocations
            .iter()
            .find(|allocation| allocation.root_id == *root_id)
            .cloned();
        let allocation = match self.allocation_provider.allocate(binding, record, existing.as_ref())
        {
            Ok(allocation) => allocation,
            Err(_) => {
                self.record(RuntimeEvent {
                    kind: RuntimeEventKind::AllocationUnavailable,
                    binding_id: Some(binding.project_id.clone()),
                    slot_id: None,
                    root_id: Some(root_id.clone()),
                    outcome: None,
                });
                return Ok(());
            }
        };
        if allocation.root_id != *root_id
            || existing.as_ref().is_some_and(|expected| expected != &allocation)
        {
            self.record(RuntimeEvent {
                kind: RuntimeEventKind::AllocationConflict,
                binding_id: Some(binding.project_id.clone()),
                slot_id: None,
                root_id: Some(root_id.clone()),
                outcome: None,
            });
            return Ok(());
        }
        if existing.is_none() {
            let mut next = self.persisted.clone();
            next.allocations.push(allocation.clone());
            if self.persist(&next).is_err() {
                self.record(RuntimeEvent {
                    kind: RuntimeEventKind::PersistenceFailed,
                    binding_id: Some(binding.project_id.clone()),
                    slot_id: None,
                    root_id: Some(root_id.clone()),
                    outcome: None,
                });
                return Ok(());
            }
            self.persisted = next;
        };

        let request = LaunchRequest::new(
            root_id.clone(),
            PathBuf::from(&binding.repository_path),
            PathBuf::from(&allocation.workspace_path),
            PathBuf::from(&allocation.run_directory),
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
                    slot_id: None,
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

fn validate_binding(binding: &ProjectBinding) -> Result<(), RuntimeError> {
    if binding.project_id.trim().is_empty()
        || binding.routing_label.trim().is_empty()
        || binding.repository_path.trim().is_empty()
        || binding.base_branch.trim().is_empty()
        || binding.concurrency == 0
        || binding.reconcile_agent != "codex"
        || binding.artist_agent != "codex"
        || binding.critic_agent != "codex"
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
        paths: HashMap<String, RootAllocation>,
        existing: Rc<RefCell<Vec<Option<RootAllocation>>>>,
    }

    impl AllocationProvider for FakeAllocation {
        type Error = &'static str;

        fn allocate(
            &mut self,
            _binding: &ProjectBinding,
            candidate: &CandidateRecord,
            existing: Option<&RootAllocation>,
        ) -> Result<RootAllocation, Self::Error> {
            self.existing.borrow_mut().push(existing.cloned());
            self.paths.get(&candidate.candidate.id).cloned().ok_or("missing allocation")
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
            reconcile_agent: "codex".into(),
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            artist_agent: "codex".into(),
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: "codex".into(),
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

    fn allocation(id: &str) -> RootAllocation {
        RootAllocation {
            root_id: id.into(),
            workspace_path: format!("/workspace/{id}"),
            run_directory: format!("/run/{id}"),
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
                    (candidate.candidate.id.clone(), allocation(&candidate.candidate.id))
                })
            })
            .collect();
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let launches = Rc::new(RefCell::new(Vec::new()));
        let mut runtime = Runtime::new(
            store,
            source,
            FakeAllocation { paths, existing: Rc::new(RefCell::new(Vec::new())) },
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
        assert_eq!(snapshot.slots.len(), 3);
        assert_eq!(launches.borrow().len(), 3);
        assert!(launches.borrow().iter().all(|request| request.max_cycles == DEFAULT_MAX_CYCLES));
        assert_eq!(snapshot.slots[0].identifier, "A-1-identifier");
        assert!(snapshot.slots.iter().all(|slot| slot.slot_id.starts_with("slot-")));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preemption_stops_before_starting_replacement_and_equal_priority_stays() {
        let binding = binding("project-a", 1);
        let mut candidates = HashMap::new();
        candidates.insert("project-a".into(), vec![candidate("low", 3)]);
        let (mut runtime, stopped, launches, directory) =
            runtime(std::slice::from_ref(&binding), candidates);
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();
        assert_eq!(launches.borrow().len(), 1);

        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("high", 1)]);
        runtime.allocation_provider.paths.insert("high".into(), allocation("high"));
        runtime.tick().unwrap();
        assert_eq!(stopped.borrow().as_slice(), ["low"]);
        assert_eq!(launches.borrow().len(), 2);
        assert_eq!(launches.borrow()[1].root, "high");

        runtime.candidate_source.values.insert("project-a".into(), vec![candidate("equal", 1)]);
        runtime.tick().unwrap();
        assert_eq!(stopped.borrow().as_slice(), ["low"]);
        assert_eq!(launches.borrow().len(), 2);
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
        assert!(runtime.snapshot().slots.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn existing_allocation_is_revalidated_before_restart_launch() {
        let binding = binding("project-a", 1);
        let record = candidate("root", 1);
        let stable = allocation("root");
        let (store, directory) = state_path("existing-allocation");
        let existing = Rc::new(RefCell::new(Vec::new()));
        let launches = Rc::new(RefCell::new(Vec::new()));
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let source =
            FakeSource { values: HashMap::from([(binding.project_id.clone(), vec![record])]) };
        let mut runtime = Runtime::from_persisted(
            store,
            PersistedState { bindings: vec![binding], allocations: vec![stable.clone()] },
            source,
            FakeAllocation {
                paths: HashMap::from([(stable.root_id.clone(), stable)]),
                existing: Rc::clone(&existing),
            },
            FakeLauncher { stopped, launches: Rc::clone(&launches), stop_ok: true },
        );
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();

        assert_eq!(existing.borrow().len(), 1);
        assert!(existing.borrow()[0].is_some());
        assert_eq!(launches.borrow().len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn mismatched_existing_allocation_is_visible_and_not_launched() {
        let binding = binding("project-a", 1);
        let record = candidate("root", 1);
        let stable = allocation("root");
        let mut replacement = stable.clone();
        replacement.run_directory = "/run/mismatch".into();
        let (store, directory) = state_path("allocation-mismatch");
        let launches = Rc::new(RefCell::new(Vec::new()));
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let mut runtime = Runtime::from_persisted(
            store,
            PersistedState { bindings: vec![binding.clone()], allocations: vec![stable] },
            FakeSource { values: HashMap::from([(binding.project_id.clone(), vec![record])]) },
            FakeAllocation {
                paths: HashMap::from([(String::from("root"), replacement)]),
                existing: Rc::new(RefCell::new(Vec::new())),
            },
            FakeLauncher { stopped, launches: Rc::clone(&launches), stop_ok: true },
        );
        runtime.start_binding("project-a").unwrap();
        runtime.tick().unwrap();

        assert!(launches.borrow().is_empty());
        assert!(runtime.snapshot().events.iter().any(|event| {
            event.kind == RuntimeEventKind::AllocationConflict
                && event.root_id.as_deref() == Some("root")
        }));
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
        assert!(runtime.snapshot().slots.is_empty());
        let events = runtime.snapshot().events;
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
        assert!(!encoded.contains("process"));
        assert!(!encoded.contains("pid"));
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("rawenv"));
        assert!(!encoded.contains("stopped"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
