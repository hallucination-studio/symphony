from __future__ import annotations

from pathlib import Path

import pytest

from performer_api.config import ConfigError, ServiceConfig
from performer_api.workflow import WorkflowError, load_workflow, render_prompt


def write_workflow(path: Path, front_matter: str, body: str = "Issue {{ issue.identifier }} attempt {{ attempt }}") -> None:
    path.write_text(f"---\n{front_matter}\n---\n{body}\n", encoding="utf-8")


def test_load_workflow_parses_front_matter_and_body(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
""",
        "Hello {{ issue.title }}",
    )

    workflow = load_workflow(workflow_path)

    assert workflow.config == {"tracker": {"kind": "linear"}}
    assert workflow.prompt_template == "Hello {{ issue.title }}"


def test_load_workflow_reports_missing_file(tmp_path: Path) -> None:
    with pytest.raises(WorkflowError) as exc:
        load_workflow(tmp_path / "WORKFLOW.md")

    assert exc.value.code == "missing_workflow_file"


def test_load_workflow_reports_invalid_yaml(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text("---\ntracker: [\n---\nDo work\n", encoding="utf-8")

    with pytest.raises(WorkflowError) as exc:
        load_workflow(workflow_path)

    assert exc.value.code == "workflow_parse_error"


def test_load_workflow_reports_non_map_front_matter(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text("---\n- tracker\n---\nDo work\n", encoding="utf-8")

    with pytest.raises(WorkflowError) as exc:
        load_workflow(workflow_path)

    assert exc.value.code == "workflow_front_matter_not_a_map"


def test_service_config_resolves_api_key_env_and_docs_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LINEAR_API_KEY", "linear-token")
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: $LINEAR_API_KEY
workspace:
  root: workspaces
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.tracker.api_key == "linear-token"
    assert config.workspace.root == tmp_path / "workspaces"
    assert config.codex.approval_policy is None
    assert config.codex.thread_sandbox is None
    assert config.codex.turn_sandbox_policy is None
    assert config.agent.max_concurrent_agents == 10
    assert "test_command_evidence" in config.completion_verification.required_checks


def test_service_config_parses_codex_sdk_backend_fields(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
codex:
  backend: sdk
  model: gpt-5-codex
  sdk_codex_bin: /usr/local/bin/codex
  sandbox: workspace_write
  linear_tool_mode: disabled
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.codex.backend == "sdk"
    assert config.codex.model == "gpt-5-codex"
    assert config.codex.sdk_codex_bin == "/usr/local/bin/codex"
    assert config.codex.sandbox == "workspace_write"
    assert config.codex.linear_tool_mode == "disabled"


def test_service_config_parses_completion_verification_extension(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
completion_verification:
  enabled: false
  required_checks:
    - repo_path
    - test_command_evidence
  optional_checks:
    - linear_state
  expected_repo_root: ./repo
  expected_test_patterns:
    - tests/test_target.py::test_fix
  auto_retry_on_fail: false
  max_verification_retries: 3
  test_timeout_seconds: 45
  min_duration_seconds: 2
  min_workspace_changes_chars: 12
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.completion_verification.enabled is False
    assert config.completion_verification.required_checks == ["repo_path", "test_command_evidence"]
    assert config.completion_verification.optional_checks == ["linear_state"]
    assert config.completion_verification.expected_repo_root == str((tmp_path / "repo").resolve())
    assert config.completion_verification.expected_test_patterns == ["tests/test_target.py::test_fix"]
    assert config.completion_verification.auto_retry_on_fail is False
    assert config.completion_verification.max_verification_retries == 3
    assert config.completion_verification.test_timeout_seconds == 45
    assert config.completion_verification.min_duration_seconds == 2
    assert config.completion_verification.min_workspace_changes_chars == 12


def test_service_config_parses_acceptance_gate_extension(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
acceptance:
  enabled: true
  mode: block_done
  minimum_score: 3
  require_findings_for_score_3: true
  auto_retry_on_fail: false
  task_type_label: performer:type/task
  acceptance_type_label: performer:type/acceptance
  gate_pending_label: performer:gate/pending
  gate_passed_label: performer:gate/passed
  gate_pass_with_findings_label: performer:gate/pass-with-findings
  gate_failed_label: performer:gate/failed
  score_label_prefix: performer:score/
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.acceptance.enabled is True
    assert config.acceptance.mode == "block_done"
    assert config.acceptance.minimum_score == 3
    assert config.acceptance.require_findings_for_score_3 is True
    assert config.acceptance.auto_retry_on_fail is False
    assert config.acceptance.task_type_label == "performer:type/task"
    assert config.acceptance.acceptance_type_label == "performer:type/acceptance"
    assert config.acceptance.gate_pending_label == "performer:gate/pending"
    assert config.acceptance.gate_passed_label == "performer:gate/passed"
    assert config.acceptance.gate_pass_with_findings_label == "performer:gate/pass-with-findings"
    assert config.acceptance.gate_failed_label == "performer:gate/failed"
    assert config.acceptance.score_label_prefix == "performer:score/"


def test_service_config_parses_repository_handoff_extension(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
repository_handoff:
  enabled: true
  bundle_root: ./state/handoffs
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.repository_handoff.enabled is True
    assert config.repository_handoff.bundle_root == (tmp_path / "state" / "handoffs").resolve()


def test_acceptance_enabled_extends_candidate_scan_states(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  active_states:
    - Ready
acceptance:
  enabled: true
  todo_state: Todo
  implementation_state: In Progress
  review_state: QA Review
  done_state: Complete
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.tracker.active_states == ["Ready", "Todo", "In Progress", "QA Review", "Complete"]


def test_completion_verification_allows_zero_min_duration_for_smoke_flows(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
completion_verification:
  min_duration_seconds: 0
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.completion_verification.min_duration_seconds == 0


def test_service_config_resolves_workspace_env_and_home_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "from-env"))
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
workspace:
  root: $WORKSPACE_ROOT
""",
    )

    env_config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)
    assert env_config.workspace.root == tmp_path / "from-env"

    home_workflow_path = tmp_path / "HOME_WORKFLOW.md"
    write_workflow(
        home_workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
workspace:
  root: ~/performer-test-workspaces
""",
    )

    home_config = ServiceConfig.from_workflow(load_workflow(home_workflow_path), home_workflow_path)
    assert str(home_config.workspace.root).endswith("performer-test-workspaces")
    assert home_config.workspace.root.is_absolute()


def test_service_config_parses_per_issue_workspace_flag(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
workspace:
  root: workspaces
  per_issue: false
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.workspace.root == tmp_path / "workspaces"
    assert config.workspace.per_issue is False


def test_service_config_preserves_codex_command_and_per_state_limits(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
agent:
  max_concurrent_agents_by_state:
    In Progress: 2
    Todo: 0
    Review: nope
codex:
  command: codex app-server --experimental
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.codex.command == "codex app-server --experimental"
    assert config.agent.max_concurrent_agents_by_state == {"in progress": 2}


def test_service_config_parses_server_extension(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
server:
  port: 8080
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.server.port == 8080
    assert config.server.host == "127.0.0.1"


def test_service_config_parses_remaining_extension_configs(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
persistence:
  path: ./state/performer.json
observability:
  enabled: true
  host: 127.0.0.2
  allow_refresh: false
worker:
  ssh_hosts:
    - builder-1
    - " "
    - builder-2
  max_concurrent_agents_per_host: 2
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.persistence.path == (tmp_path / "state" / "performer.json").resolve()
    assert config.observability.enabled is True
    assert config.observability.host == "127.0.0.2"
    assert config.observability.allow_refresh is False
    assert config.worker.ssh_hosts == ["builder-1", "builder-2"]
    assert config.worker.max_concurrent_agents_per_host == 2


def test_service_config_extension_defaults_are_safe(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.persistence.path is None
    assert config.observability.enabled is True
    assert config.observability.host == "127.0.0.1"
    assert config.observability.allow_refresh is True
    assert config.worker.ssh_hosts == []
    assert config.worker.max_concurrent_agents_per_host == 1


def test_invalid_worker_per_host_limit_fails_config_validation(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
worker:
  ssh_hosts:
    - builder-1
  max_concurrent_agents_per_host: 0
""",
    )

    with pytest.raises(ConfigError) as exc:
        ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert exc.value.code == "invalid_worker_max_concurrent_agents_per_host"


def test_dispatch_validation_rejects_unregistered_tracker_kind(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: github
  project_slug: MT
  api_key: token
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    config.validate_for_dispatch()


def test_non_linear_tracker_config_does_not_require_linear_auth_or_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from performer.tracker import register_tracker_adapter

    class CustomTracker:
        def __init__(self, config):
            self.config = config

    register_tracker_adapter("custom-no-auth-config", CustomTracker)
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: custom-no-auth-config
  endpoint: https://tracker.example/api
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)
    config.validate_for_dispatch()

    assert config.tracker.kind == "custom-no-auth-config"
    assert config.tracker.api_key == ""
    assert config.tracker.project_slug == ""


def test_service_config_ignores_legacy_required_labels(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  required_labels: ["codex", " "]
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert not hasattr(config.tracker, "required_labels")


def test_tracker_assignee_id_config_is_ignored(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  assignee_id: user-123
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert not hasattr(config.tracker, "assignee_id")


def test_tracker_required_delegate_id_config_is_preserved(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  required_delegate_id: app-user-123
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.tracker.required_delegate_id == "app-user-123"


def test_tracker_lifecycle_labels_enabled_can_be_disabled(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  lifecycle_labels_enabled: false
""",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.tracker.lifecycle_labels_enabled is False


def test_service_config_validation_requires_api_key(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
""",
    )

    with pytest.raises(ConfigError) as exc:
        ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert exc.value.code == "missing_tracker_api_key"


def test_invalid_hook_timeout_fails_config_validation(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
hooks:
  timeout_ms: 0
""",
    )

    with pytest.raises(ConfigError) as exc:
        ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert exc.value.code == "invalid_hook_timeout_ms"


def test_invalid_agent_max_turns_fails_config_validation(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    write_workflow(
        workflow_path,
        """
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
agent:
  max_turns: 0
""",
    )

    with pytest.raises(ConfigError) as exc:
        ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert exc.value.code == "invalid_agent_max_turns"


def test_render_prompt_fails_on_unknown_variable() -> None:
    with pytest.raises(WorkflowError) as exc:
        render_prompt("Hello {{ missing.name }}", {"issue": {"identifier": "MT-1"}, "attempt": None})

    assert exc.value.code == "template_render_error"


def test_render_prompt_reports_template_parse_error() -> None:
    with pytest.raises(WorkflowError) as exc:
        render_prompt("Hello {{ issue.identifier ", {"issue": {"identifier": "MT-1"}, "attempt": None})

    assert exc.value.code == "template_parse_error"


def test_render_prompt_preserves_nested_issue_values_and_attempt() -> None:
    rendered = render_prompt(
        "Issue {{ issue.identifier }} labels {{ issue.labels[0] }} blocker {{ issue.blocked_by[0].identifier }} attempt {{ attempt }}",
        {
            "issue": {
                "identifier": "MT-1",
                "labels": ["codex"],
                "blocked_by": [{"identifier": "MT-0"}],
            },
            "attempt": 2,
        },
    )

    assert rendered == "Issue MT-1 labels codex blocker MT-0 attempt 2"


def test_render_prompt_fails_on_unknown_filter() -> None:
    with pytest.raises(WorkflowError) as exc:
        render_prompt("Hello {{ issue.identifier | missing_filter }}", {"issue": {"identifier": "MT-1"}, "attempt": None})

    assert exc.value.code == "template_render_error"
