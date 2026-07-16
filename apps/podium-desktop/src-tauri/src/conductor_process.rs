#[derive(Debug, PartialEq, Eq)]
pub enum SupervisorError {
    ExistingProcessNotExited,
    BindingNotRunning,
    InstanceMismatch,
}

#[derive(Debug, PartialEq, Eq)]
enum ProcessHealth {
    Running,
    NotResponding,
}

#[derive(Debug)]
struct ActiveProcess {
    binding_id: String,
    instance_id: String,
    health: ProcessHealth,
}

#[derive(Default)]
pub struct SupervisorState {
    active: Option<ActiveProcess>,
}

impl SupervisorState {
    pub fn started(&mut self, binding_id: &str, instance_id: &str) -> Result<(), SupervisorError> {
        if self.active.is_some() {
            return Err(SupervisorError::ExistingProcessNotExited);
        }
        self.active = Some(ActiveProcess {
            binding_id: binding_id.to_owned(),
            instance_id: instance_id.to_owned(),
            health: ProcessHealth::Running,
        });
        Ok(())
    }

    pub fn not_responding(
        &mut self,
        binding_id: &str,
        instance_id: &str,
    ) -> Result<(), SupervisorError> {
        let process = self.matching_process_mut(binding_id, instance_id)?;
        process.health = ProcessHealth::NotResponding;
        Ok(())
    }

    pub fn observed_exit(
        &mut self,
        binding_id: &str,
        instance_id: &str,
    ) -> Result<(), SupervisorError> {
        self.matching_process_mut(binding_id, instance_id)?;
        self.active = None;
        Ok(())
    }

    fn matching_process_mut(
        &mut self,
        binding_id: &str,
        instance_id: &str,
    ) -> Result<&mut ActiveProcess, SupervisorError> {
        let process = self.active.as_mut().ok_or(SupervisorError::BindingNotRunning)?;
        if process.binding_id != binding_id || process.instance_id != instance_id {
            return Err(SupervisorError::InstanceMismatch);
        }
        Ok(process)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_responding_never_authorizes_a_replacement() {
        let mut supervisor = SupervisorState::default();
        supervisor.started("binding-1", "instance-1").unwrap();
        supervisor.not_responding("binding-1", "instance-1").unwrap();

        assert_eq!(
            supervisor.started("binding-1", "instance-2").unwrap_err(),
            SupervisorError::ExistingProcessNotExited
        );
    }

    #[test]
    fn v1_never_runs_a_second_binding_concurrently() {
        let mut supervisor = SupervisorState::default();
        supervisor.started("binding-1", "instance-1").unwrap();

        assert_eq!(
            supervisor.started("binding-2", "instance-2").unwrap_err(),
            SupervisorError::ExistingProcessNotExited
        );
    }

    #[test]
    fn observed_exit_authorizes_exactly_one_replacement() {
        let mut supervisor = SupervisorState::default();
        supervisor.started("binding-1", "instance-1").unwrap();
        supervisor.observed_exit("binding-1", "instance-1").unwrap();
        supervisor.started("binding-1", "instance-2").unwrap();

        assert_eq!(
            supervisor.started("binding-1", "instance-3").unwrap_err(),
            SupervisorError::ExistingProcessNotExited
        );
    }

    #[test]
    fn stale_exit_cannot_release_the_current_controller() {
        let mut supervisor = SupervisorState::default();
        supervisor.started("binding-1", "instance-1").unwrap();

        assert_eq!(
            supervisor.observed_exit("binding-1", "different-instance").unwrap_err(),
            SupervisorError::InstanceMismatch
        );
        assert_eq!(
            supervisor.started("binding-1", "instance-2").unwrap_err(),
            SupervisorError::ExistingProcessNotExited
        );
    }
}
