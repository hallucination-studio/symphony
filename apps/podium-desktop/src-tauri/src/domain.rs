use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleLaunchConfig {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectBinding {
    pub project_id: String,
    pub routing_label: String,
    pub repository_path: String,
    pub base_branch: String,
    pub concurrency: u32,
    pub reconcile_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile_reasoning_effort: Option<String>,
    pub execute_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_reasoning_effort: Option<String>,
    pub audit_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_reasoning_effort: Option<String>,
}

impl ProjectBinding {
    pub fn reconcile_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.reconcile_agent.clone(),
            model: self.reconcile_model.clone(),
            reasoning_effort: self.reconcile_reasoning_effort.clone(),
        }
    }

    pub fn execute_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.execute_agent.clone(),
            model: self.execute_model.clone(),
            reasoning_effort: self.execute_reasoning_effort.clone(),
        }
    }

    pub fn audit_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.audit_agent.clone(),
            model: self.audit_model.clone(),
            reasoning_effort: self.audit_reasoning_effort.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootAllocation {
    pub root_id: String,
    pub workspace_path: String,
    pub run_directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootCandidate {
    pub id: String,
    /// Linear priority: 1 Urgent, 2 High, 3 Normal, 4 Low, 0 No priority.
    pub priority: u8,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_values_round_trip_as_json() {
        let binding = ProjectBinding {
            project_id: "project-1".into(),
            routing_label: "core".into(),
            repository_path: "/repo".into(),
            base_branch: "main".into(),
            concurrency: 2,
            reconcile_agent: "codex".into(),
            reconcile_model: Some("gpt-5".into()),
            reconcile_reasoning_effort: Some("high".into()),
            execute_agent: "codex".into(),
            execute_model: None,
            execute_reasoning_effort: None,
            audit_agent: "codex".into(),
            audit_model: None,
            audit_reasoning_effort: Some("medium".into()),
        };
        let allocation = RootAllocation {
            root_id: "ENG-1".into(),
            workspace_path: "/work/ENG-1".into(),
            run_directory: "/runs/ENG-1".into(),
        };

        let json = serde_json::to_string(&(&binding, &allocation)).unwrap();
        let (decoded_binding, decoded_allocation): (ProjectBinding, RootAllocation) =
            serde_json::from_str(&json).unwrap();

        assert_eq!(decoded_binding, binding);
        assert_eq!(decoded_allocation, allocation);
        assert_eq!(binding.reconcile_config().agent, "codex");
        assert_eq!(binding.reconcile_config().model.as_deref(), Some("gpt-5"));
    }
}
