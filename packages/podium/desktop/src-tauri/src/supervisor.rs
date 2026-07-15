use std::path::Path;

use crate::conductor_process::ConductorProcess;
use crate::process_state::{DesiredProcess, ObservedProcess, ProcessStatus};
use crate::shutdown::ShutdownTarget;

const MAX_CRASH_RESTARTS: u8 = 2;

pub trait ManagedProcess {
    fn exited(&mut self) -> Result<bool, &'static str>;
    fn shutdown(&mut self) -> Result<(), &'static str>;
}

impl ManagedProcess for ConductorProcess {
    fn exited(&mut self) -> Result<bool, &'static str> {
        ConductorProcess::exited(self).map_err(|_| "conductor_status_failed")
    }

    fn shutdown(&mut self) -> Result<(), &'static str> {
        self.shutdown_checked()
    }
}

pub struct ProcessSupervisor<P, F>
where
    P: ManagedProcess,
    F: FnMut(&Path) -> Result<P, &'static str>,
{
    desired: Option<DesiredProcess>,
    observed: ObservedProcess,
    process: Option<P>,
    start: F,
}

impl<P, F> ProcessSupervisor<P, F>
where
    P: ManagedProcess,
    F: FnMut(&Path) -> Result<P, &'static str>,
{
    pub fn new(start: F) -> Self {
        Self { desired: None, observed: ObservedProcess::default(), process: None, start }
    }

    pub fn observed(&self) -> &ObservedProcess {
        &self.observed
    }

    pub fn reconcile(&mut self, desired: DesiredProcess) -> Result<(), &'static str> {
        if desired.revision <= self.observed.applied_revision {
            return Err("desired_revision_not_increased");
        }
        let revision = desired.revision;
        let active = desired.active;
        self.stop_current()?;
        self.desired = Some(desired);
        self.observed.crash_count = 0;
        self.observed.error_code = None;

        if active {
            self.start_current()?;
        } else {
            self.observed.status = ProcessStatus::Stopped;
        }
        self.observed.applied_revision = revision;
        Ok(())
    }

    pub fn poll(&mut self) -> Result<(), &'static str> {
        let Some(process) = self.process.as_mut() else {
            return Ok(());
        };
        match process.exited() {
            Ok(false) => return Ok(()),
            Err(error_code) => {
                self.fail(ProcessStatus::Failed, error_code);
                return Err(error_code);
            }
            Ok(true) => {}
        }

        self.process = None;
        self.observed.crash_count += 1;
        if self.observed.crash_count > MAX_CRASH_RESTARTS {
            self.fail(ProcessStatus::NeedsAttention, "conductor_crash_loop");
            return Ok(());
        }
        self.start_current()
    }

    fn start_current(&mut self) -> Result<(), &'static str> {
        let data_root = &self.desired.as_ref().ok_or("desired_process_missing")?.data_root;
        match (self.start)(data_root) {
            Ok(process) => {
                self.process = Some(process);
                self.observed.status = ProcessStatus::Running;
                self.observed.error_code = None;
                Ok(())
            }
            Err(error_code) => {
                self.fail(ProcessStatus::Failed, error_code);
                Err(error_code)
            }
        }
    }

    fn stop_current(&mut self) -> Result<(), &'static str> {
        let Some(mut process) = self.process.take() else {
            return Ok(());
        };
        if let Err(error_code) = process.shutdown() {
            self.process = Some(process);
            self.fail(ProcessStatus::Failed, error_code);
            return Err(error_code);
        }
        self.observed.status = ProcessStatus::Stopped;
        self.observed.error_code = None;
        Ok(())
    }

    fn fail(&mut self, status: ProcessStatus, error_code: &'static str) {
        self.observed.status = status;
        self.observed.error_code = Some(error_code);
        eprintln!(
            "event=desktop_process_reconcile_failed error_type=process_lifecycle \
             error_code={error_code} sanitized_reason={error_code} action_required=true \
             retryable=false next_action=inspect_desktop_runtime"
        );
    }
}

impl<P, F> ShutdownTarget for ProcessSupervisor<P, F>
where
    P: ManagedProcess,
    F: FnMut(&Path) -> Result<P, &'static str>,
{
    fn shutdown(&mut self) -> Result<(), &'static str> {
        self.stop_current()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    #[derive(Clone)]
    struct FakeProcess {
        state: Rc<RefCell<FakeState>>,
    }

    #[derive(Default)]
    struct FakeState {
        exited: bool,
        status_error: Option<&'static str>,
        shutdowns: usize,
        shutdown_error: Option<&'static str>,
    }

    impl ManagedProcess for FakeProcess {
        fn exited(&mut self) -> Result<bool, &'static str> {
            let state = self.state.borrow();
            state.status_error.map_or(Ok(state.exited), Err)
        }

        fn shutdown(&mut self) -> Result<(), &'static str> {
            let mut state = self.state.borrow_mut();
            state.shutdowns += 1;
            state.shutdown_error.take().map_or(Ok(()), Err)
        }
    }

    fn desired(revision: u64, active: bool) -> DesiredProcess {
        DesiredProcess::new(revision, active, PathBuf::from("/tmp/bound-project")).unwrap()
    }

    #[test]
    fn applies_each_new_revision_once_and_stops_inactive_process() {
        let starts = Rc::new(RefCell::new(Vec::new()));
        let states = Rc::new(RefCell::new(Vec::new()));
        let start_states = Rc::clone(&states);
        let start_paths = Rc::clone(&starts);
        let mut supervisor = ProcessSupervisor::new(move |path: &Path| {
            start_paths.borrow_mut().push(path.to_path_buf());
            let state = Rc::new(RefCell::new(FakeState::default()));
            start_states.borrow_mut().push(Rc::clone(&state));
            Ok(FakeProcess { state })
        });

        supervisor.reconcile(desired(1, true)).unwrap();
        assert_eq!(supervisor.observed().applied_revision, 1);
        assert_eq!(supervisor.observed().status, ProcessStatus::Running);
        assert_eq!(supervisor.reconcile(desired(1, true)), Err("desired_revision_not_increased"));

        supervisor.reconcile(desired(2, true)).unwrap();
        supervisor.reconcile(desired(3, false)).unwrap();

        assert_eq!(starts.borrow().len(), 2);
        assert_eq!(states.borrow()[0].borrow().shutdowns, 1);
        assert_eq!(states.borrow()[1].borrow().shutdowns, 1);
        assert_eq!(supervisor.observed().applied_revision, 3);
        assert_eq!(supervisor.observed().status, ProcessStatus::Stopped);
    }

    #[test]
    fn bounds_crash_restarts_and_requires_attention() {
        let states = Rc::new(RefCell::new(Vec::new()));
        let start_states = Rc::clone(&states);
        let mut supervisor = ProcessSupervisor::new(move |_path: &Path| {
            let state = Rc::new(RefCell::new(FakeState::default()));
            start_states.borrow_mut().push(Rc::clone(&state));
            Ok(FakeProcess { state })
        });
        supervisor.reconcile(desired(1, true)).unwrap();

        for index in 0..=MAX_CRASH_RESTARTS {
            states.borrow()[index as usize].borrow_mut().exited = true;
            supervisor.poll().unwrap();
        }

        assert_eq!(states.borrow().len(), 3);
        assert_eq!(supervisor.observed().status, ProcessStatus::NeedsAttention);
        assert_eq!(supervisor.observed().error_code, Some("conductor_crash_loop"));
    }

    #[test]
    fn keeps_shutdown_failure_observable() {
        let state = Rc::new(RefCell::new(FakeState {
            shutdown_error: Some("conductor_shutdown_failed"),
            ..FakeState::default()
        }));
        let process_state = Rc::clone(&state);
        let mut supervisor = ProcessSupervisor::new(move |_path: &Path| {
            Ok(FakeProcess { state: Rc::clone(&process_state) })
        });
        supervisor.reconcile(desired(1, true)).unwrap();

        assert_eq!(supervisor.shutdown(), Err("conductor_shutdown_failed"));
        assert_eq!(state.borrow().shutdowns, 1);
        assert_eq!(supervisor.observed().status, ProcessStatus::Failed);
        assert_eq!(supervisor.observed().error_code, Some("conductor_shutdown_failed"));

        supervisor.shutdown().unwrap();
        assert_eq!(state.borrow().shutdowns, 2);
        assert_eq!(supervisor.observed().status, ProcessStatus::Stopped);
        assert_eq!(supervisor.observed().error_code, None);
    }

    #[test]
    fn keeps_status_failure_observable() {
        let state = Rc::new(RefCell::new(FakeState {
            status_error: Some("conductor_status_failed"),
            ..FakeState::default()
        }));
        let process_state = Rc::clone(&state);
        let mut supervisor = ProcessSupervisor::new(move |_path: &Path| {
            Ok(FakeProcess { state: Rc::clone(&process_state) })
        });
        supervisor.reconcile(desired(1, true)).unwrap();

        assert_eq!(supervisor.poll(), Err("conductor_status_failed"));
        assert_eq!(supervisor.observed().status, ProcessStatus::Failed);
        assert_eq!(supervisor.observed().error_code, Some("conductor_status_failed"));
    }
}
