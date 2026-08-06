use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleLaunchConfig {
    pub agent: AgentKind,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_workspace_retention: Option<u32>,
    pub reconcile_agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile_reasoning_effort: Option<String>,
    pub artist_agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_reasoning_effort: Option<String>,
    pub critic_agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub critic_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub critic_reasoning_effort: Option<String>,
}

impl ProjectBinding {
    pub fn reconcile_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.reconcile_agent,
            model: self.reconcile_model.clone(),
            reasoning_effort: self.reconcile_reasoning_effort.clone(),
        }
    }

    pub fn artist_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.artist_agent,
            model: self.artist_model.clone(),
            reasoning_effort: self.artist_reasoning_effort.clone(),
        }
    }

    pub fn critic_config(&self) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: self.critic_agent,
            model: self.critic_model.clone(),
            reasoning_effort: self.critic_reasoning_effort.clone(),
        }
    }
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
    fn binding_round_trip_preserves_retention_and_has_no_root_allocation() {
        let binding = ProjectBinding {
            project_id: "project-1".into(),
            routing_label: "core".into(),
            repository_path: "/repo".into(),
            base_branch: "main".into(),
            concurrency: 2,
            completed_workspace_retention: Some(7),
            reconcile_agent: AgentKind::Codex,
            reconcile_model: Some("gpt-5".into()),
            reconcile_reasoning_effort: Some("high".into()),
            artist_agent: AgentKind::Codex,
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: AgentKind::Codex,
            critic_model: None,
            critic_reasoning_effort: Some("medium".into()),
        };

        let json = serde_json::to_string(&binding).unwrap();
        let decoded_binding: ProjectBinding = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded_binding, binding);
        assert!(json.contains("\"completed_workspace_retention\":7"));
        assert!(!json.contains("root_id"));
        assert!(!json.contains("workspace_path"));
        assert!(!json.contains("run_directory"));
        assert_eq!(binding.reconcile_config().agent, AgentKind::Codex);
        assert_eq!(binding.reconcile_config().model.as_deref(), Some("gpt-5"));

        let without_retention = ProjectBinding { completed_workspace_retention: None, ..binding };
        let without_retention_json = serde_json::to_string(&without_retention).unwrap();
        assert!(!without_retention_json.contains("completed_workspace_retention"));
    }

    #[test]
    fn non_codex_agents_are_not_part_of_the_binding_contract() {
        let json = r#"
        {
          "project_id": "project-1",
          "routing_label": "core",
          "repository_path": "/repo",
          "base_branch": "main",
          "concurrency": 1,
          "completed_workspace_retention": 3,
          "reconcile_agent": "other",
          "artist_agent": "codex",
          "critic_agent": "codex"
        }
        "#;

        assert!(serde_json::from_str::<ProjectBinding>(json).is_err());
    }
}
