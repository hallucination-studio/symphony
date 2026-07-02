from __future__ import annotations

from pathlib import Path

from conductor.conductor_models import InstanceRecord, WorkflowValidationResult
from conductor.conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)


def make_instance(tmp_path: Path) -> InstanceRecord:
    instance_dir = tmp_path / "instances" / "inst-1"
    return InstanceRecord.create(
        name="Example",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(instance_dir),
        linear_project="ENG",
        linear_filters={"labels": ["codex"], "active_states": ["Todo", "In Progress"]},
        workflow_profile="default",
        workflow_inputs={"goal": "Keep issues moving"},
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        workflow_path=str(instance_dir / "WORKFLOW.md"),
        http_port=8811,
    )


def test_generate_workflow_content_injects_managed_runtime_resources(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)

    content = generate_workflow_content(instance)

    assert "workspace:" in content
    assert f"root: {instance.workspace_root}" in content
    assert "per_issue: false" in content
    assert f"path: {instance.persistence_path}" in content
    assert "agent:" in content
    assert "max_turns: 20" in content
    assert "acceptance:" in content
    assert "enabled: false" in content
    assert "mode: block_done" in content
    assert "lifecycle_labels_enabled: false" in content
    assert "review_state:" not in content
    assert "gate_passed_label:" not in content
    assert "performer:" not in content
    assert "server:" not in content
    assert "observability:" not in content
    assert "project_slug: ENG" in content
    assert "endpoint: https://podium.example/api/v1/linear/graphql" in content
    assert "api_key: $PODIUM_PROXY_TOKEN" in content
    assert "required_labels:" not in content
    assert "    - codex" not in content
    assert "api_key: $LINEAR_API_KEY" not in content
    assert "Keep issues moving" in content
    assert "Current Linear issue:" in content
    assert "Identifier: {{ issue.identifier }}" in content
    assert "Title: {{ issue.title }}" in content
    assert "Issue ID: {{ issue.id }}" in content
    assert "{{ issue.description or 'No description provided.' }}" in content
    assert "after_create: |" not in content
    assert "rsync -a --delete" not in content
    assert "Prepared workspace root:" in content
    assert "Work only in the prepared workspace root." in content
    assert "Acceptance gates are disabled for this managed profile." in content
    assert "transition the issue to Done" in content
    assert "/symphony approve-runtime-error {{ issue.identifier }}" in content
    assert "records a runtime permission or sandbox error" in content
    assert "query CurrentIssue" in content
    assert "mutation UpdateIssueEvidence" in content
    assert "mutation CompleteIssue" in content
    assert "stateId" in content
    assert "commentCreate" in content
    assert "issueUpdate" in content
    assert "linear_graphql" in content


def test_task_profile_is_default_managed_profile_without_acceptance_gate(tmp_path: Path) -> None:
    instance = make_instance(tmp_path).with_updates(workflow_profile="task")

    content = generate_workflow_content(instance, podium_url="https://podium.example")

    assert "acceptance:\n  enabled: false\n" in content
    assert "endpoint: https://podium.example/api/v1/linear/graphql" in content
    assert "api_key: $PODIUM_PROXY_TOKEN" in content
    assert "lifecycle_labels_enabled: false" in content
    assert "performer:" not in content


def test_managed_workflow_requires_agent_delegation_identity_in_performer_tracker(tmp_path: Path) -> None:
    instance = make_instance(tmp_path).with_updates(
        linear_filters={
            "linear_agent_app_user_id": "app-user-1",
            "labels": ["legacy-label-that-should-not-dispatch"],
        }
    )

    content = generate_workflow_content(instance, podium_url="https://podium.example")

    assert "required_delegate_id: app-user-1" in content
    assert "linear_agent_app_user_id:" not in content
    assert "assignee_id:" not in content
    assert "required_labels:" not in content
    assert "legacy-label-that-should-not-dispatch" not in content


def test_gated_task_profile_keeps_acceptance_gate(tmp_path: Path) -> None:
    instance = make_instance(tmp_path).with_updates(workflow_profile="gated-task")

    content = generate_workflow_content(instance, podium_url="https://podium.example")

    assert "acceptance:\n  enabled: true\n" in content
    assert "lifecycle_labels_enabled: true" in content
    assert "gate_passed_label: performer:gate/passed" in content
    assert "Do not move the issue to Done yourself" in content


def test_available_profiles_include_smoke_task_and_gated_task() -> None:
    names = [profile["name"] for profile in workflow_profiles()]

    assert names == ["smoke", "task", "gated-task"]


def test_validate_instance_workflow_reports_yaml_errors(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    instance = instance.with_updates(workflow_content="---\ntracker: [\n---\nBroken\n")

    result = validate_instance_workflow(instance, [])

    assert result.ok is False
    assert result.error_code == "workflow_parse_error"
    assert result.diagnostics


def test_validate_instance_workflow_rejects_missing_required_fields(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    instance = instance.with_updates(
        workflow_content="""---
workspace:
  root: /tmp/work
server:
  port: 8811
---
Prompt
"""
    )

    result = validate_instance_workflow(instance, [])

    assert result.ok is False
    assert result.error_code == "missing_tracker_project_slug"


def test_validate_instance_workflow_rejects_resource_collisions(tmp_path: Path) -> None:
    current = make_instance(tmp_path)
    other = InstanceRecord.create(
        name="Other",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo-2"),
        resolved_repo_path=str(tmp_path / "repo-2"),
        instance_dir=str(tmp_path / "instances" / "inst-2"),
        linear_project="OPS",
        linear_filters={},
        workflow_profile="default",
        workflow_inputs={},
        workspace_root=current.workspace_root,
        persistence_path=str(tmp_path / "instances" / "inst-2" / "state" / "performer.json"),
        log_path=str(tmp_path / "instances" / "inst-2" / "logs" / "performer.log"),
        workflow_path=str(tmp_path / "instances" / "inst-2" / "WORKFLOW.md"),
        http_port=9911,
    )
    current = current.with_updates(workflow_content=generate_workflow_content(current))

    result = validate_instance_workflow(current, [other])

    assert result.ok is False
    assert result.error_code == "resource_collision"
    assert any("workspace.root" in item for item in result.diagnostics)


def test_validate_instance_workflow_round_trips_current_parser(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    instance = instance.with_updates(workflow_content=generate_workflow_content(instance))

    result = validate_instance_workflow(instance, [])

    assert result == WorkflowValidationResult(ok=True, error_code=None, diagnostics=[])


def test_validate_instance_workflow_requires_managed_runtime_resources(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    instance = instance.with_updates(
        workflow_content="""---
tracker:
  kind: linear
  project_slug: ENG
  api_key: $LINEAR_API_KEY
workspace:
  root: /tmp/not-the-managed-root
persistence:
  path: /tmp/not-the-managed-state.json
---
Prompt
"""
    )

    result = validate_instance_workflow(instance, [])

    assert result.ok is False
    assert result.error_code == "managed_resource_mismatch"
    assert len(result.diagnostics) == 2


def test_generate_workflow_content_requires_known_profile(tmp_path: Path) -> None:
    instance = make_instance(tmp_path).with_updates(workflow_profile="unknown")

    try:
        generate_workflow_content(instance)
    except ConductorValidationError as exc:
        assert exc.code == "unknown_workflow_profile"
    else:
        raise AssertionError("expected ConductorValidationError")
