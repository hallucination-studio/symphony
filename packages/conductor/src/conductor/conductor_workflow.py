from __future__ import annotations

from pathlib import Path
import tempfile

from performer_api.config import ConfigError, ServiceConfig
from .conductor_models import InstanceRecord, WorkflowValidationResult
from performer_api.workflow import WorkflowError, load_workflow


class ConductorValidationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def workflow_profiles() -> list[dict[str, str]]:
    return [
        {
            "name": "smoke",
            "label": "Smoke",
            "description": "One simple managed issue execution with acceptance disabled.",
        },
        {
            "name": "task",
            "label": "Task",
            "description": "Normal managed task execution with acceptance disabled.",
        },
        {
            "name": "gated-task",
            "label": "Gated Task",
            "description": "Managed task execution with the acceptance gate enabled.",
        },
    ]


def generate_workflow_content(instance: InstanceRecord, *, podium_url: str = "https://podium.example") -> str:
    profile = "task" if instance.workflow_profile == "default" else instance.workflow_profile
    if profile not in {"smoke", "task", "gated-task"}:
        raise ConductorValidationError(
            "unknown_workflow_profile",
            f"Unknown workflow profile: {instance.workflow_profile}",
    )

    goal = str(instance.workflow_inputs.get("goal") or "Move the Linear queue forward.")
    active_states = instance.linear_filters.get("active_states") or ["Todo", "In Progress"]
    terminal_states = instance.linear_filters.get("terminal_states") or ["Closed", "Cancelled", "Canceled", "Done"]

    active_yaml = "\n".join(f"    - {state}" for state in active_states)
    terminal_yaml = "\n".join(f"    - {state}" for state in terminal_states)
    lifecycle_labels_enabled = "true" if profile == "gated-task" else "false"
    acceptance_enabled = "true" if profile == "gated-task" else "false"
    max_concurrent_agents = 1 if profile == "smoke" else 10
    max_turns = 8 if profile == "smoke" else 20
    acceptance_guidance = (
        "Acceptance gates are enabled. Before handing off, leave concrete evidence on the Linear issue "
        "description with fields named exactly `Implementation summary:`, `Test commands and exact output:`, and "
        "`Remaining risks:`. Do not move the issue to Done yourself; Performer will move it to review, run gate child "
        "issues, create evidence child issues, and close the tree if acceptance passes.\n"
        if profile == "gated-task"
        else "Acceptance gates are disabled for this managed profile. After implementing and verifying the request, "
        "update the Linear issue description with fields named exactly `Implementation summary:`, "
        "`Test commands and exact output:`, and `Remaining risks:`, create a handoff comment, then transition "
        "the issue to Done using linear_graphql. Do not leave the issue in Todo, In Progress, or another active state "
        "after verification passes.\n"
    )
    acceptance_config = (
        "acceptance:\n"
        f"  enabled: {acceptance_enabled}\n"
        "  mode: block_done\n"
        "  minimum_score: 3\n"
        "  require_findings_for_score_3: true\n"
        "  auto_retry_on_fail: true\n"
    )
    if profile == "gated-task":
        acceptance_config += (
            "  todo_state: Todo\n"
            "  implementation_state: In Progress\n"
            "  review_state: In Review\n"
            "  done_state: Done\n"
            "  task_type_label: performer:type/task\n"
            "  gate_type_label: performer:type/gate\n"
            "  evidence_type_label: performer:type/evidence\n"
            "  gate_pending_label: performer:gate/pending\n"
            "  gate_passed_label: performer:gate/passed\n"
            "  gate_pass_with_findings_label: performer:gate/pass-with-findings\n"
            "  gate_failed_label: performer:gate/failed\n"
            "  score_label_prefix: performer:score/\n"
        )

    return (
        "---\n"
        "tracker:\n"
        "  kind: linear\n"
        f"  endpoint: {podium_url.strip().rstrip('/')}/api/v1/linear/graphql\n"
        f"  project_slug: {instance.linear_project}\n"
        "  api_key: $PODIUM_PROXY_TOKEN\n"
        f"  lifecycle_labels_enabled: {lifecycle_labels_enabled}\n"
        "  active_states:\n"
        f"{active_yaml}\n"
        "  terminal_states:\n"
        f"{terminal_yaml}\n"
        "workspace:\n"
        f"  root: {instance.workspace_root}\n"
        "  per_issue: false\n"
        "persistence:\n"
        f"  path: {instance.persistence_path}\n"
        "agent:\n"
        f"  max_concurrent_agents: {max_concurrent_agents}\n"
        f"  max_turns: {max_turns}\n"
        "  max_retry_backoff_ms: 300000\n"
        f"{acceptance_config}"
        "codex:\n"
        "  command: codex app-server\n"
        "---\n"
        f'You are operating the Performer instance "{instance.name}" for Linear project {instance.linear_project}.\n'
        f"Prepared workspace root: {instance.workspace_root}\n"
        f"Source repository path: {instance.resolved_repo_path}\n"
        f"Instance goal: {goal}\n"
        "Work only in the prepared workspace root. Do not write to the source repository path.\n"
        "Respect the managed workspace and persistence path from this workflow.\n"
        "Use the Linear issue as the source of truth for the requested work.\n"
        "Current Linear issue:\n"
        "- Identifier: {{ issue.identifier }}\n"
        "- Issue ID: {{ issue.id }}\n"
        "- Title: {{ issue.title }}\n"
        "- URL: {{ issue.url or 'No URL provided.' }}\n"
        "- State: {{ issue.state }}\n"
        "- Description: {{ issue.description or 'No description provided.' }}\n"
        f"{acceptance_guidance}"
        "If Performer records a runtime permission or sandbox error, a human must inspect the error, fix or approve "
        "the environment, then comment this exact command on the Linear issue to "
        "resume: `/symphony approve-runtime-error {{ issue.identifier }}`.\n"
        "Use one linear_graphql call per GraphQL operation when updating Linear evidence. For example:\n"
        "1. Read the current issue description:\n"
        "query CurrentIssue($issueId: String!) {\n"
        "  issue(id: $issueId) {\n"
        "    id\n"
        "    identifier\n"
        "    description\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\"}}\n"
        "2. Update the issue description with the required evidence fields:\n"
        "mutation UpdateIssueEvidence($issueId: String!, $description: String!) {\n"
        "  issueUpdate(id: $issueId, input: { description: $description }) {\n"
        "    success\n"
        "    issue { id identifier }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\", \"description\": \"<existing description plus evidence fields>\"}}\n"
        "3. Create a handoff comment with the implementation and verification summary:\n"
        "mutation HandoffIssueComment($issueId: String!, $body: String!) {\n"
        "  commentCreate(input: { issueId: $issueId, body: $body }) {\n"
        "    success\n"
        "    comment { id }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\", \"body\": \"Implemented and ready for acceptance review.\"}}\n"
        "4. If acceptance gates are disabled and verification passed, transition the issue to Done. First query the issue team states:\n"
        "query IssueTeamStates($issueId: String!) {\n"
        "  issue(id: $issueId) {\n"
        "    id\n"
        "    team { states(first: 50) { nodes { id name type } } }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\"}}\n"
        "Then use the `Done` state id, or the first state with type `completed` if no state is literally named Done:\n"
        "mutation CompleteIssue($issueId: String!, $stateId: String!) {\n"
        "  issueUpdate(id: $issueId, input: { stateId: $stateId }) {\n"
        "    success\n"
        "    issue { id identifier state { name } }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\", \"stateId\": \"<done state id>\"}}\n"
    )


def validate_instance_workflow(
    instance: InstanceRecord,
    other_instances: list[InstanceRecord],
    *,
    persist: bool = True,
) -> WorkflowValidationResult:
    collision_diagnostics = _resource_collisions(instance, other_instances)
    if collision_diagnostics:
        return WorkflowValidationResult(ok=False, error_code="resource_collision", diagnostics=collision_diagnostics)

    workflow_path = Path(instance.workflow_path)
    cleanup_path: Path | None = None
    if persist:
        workflow_path.parent.mkdir(parents=True, exist_ok=True)
        workflow_path.write_text(instance.workflow_content, encoding="utf-8")
    else:
        temp_dir = Path(tempfile.mkdtemp(prefix="conductor-preview-"))
        workflow_path = temp_dir / "WORKFLOW.md"
        workflow_path.write_text(instance.workflow_content, encoding="utf-8")
        cleanup_path = workflow_path
    try:
        loaded = load_workflow(workflow_path)
        config = _load_service_config_for_validation(loaded, workflow_path)
    except WorkflowError as exc:
        return WorkflowValidationResult(ok=False, error_code=exc.code, diagnostics=[str(exc)])
    except ConfigError as exc:
        return WorkflowValidationResult(ok=False, error_code=exc.code, diagnostics=[str(exc)])
    finally:
        if cleanup_path is not None:
            temp_root = cleanup_path.parent
            cleanup_path.unlink(missing_ok=True)
            temp_root.rmdir()

    diagnostics = _managed_resource_mismatches(instance, config)
    if diagnostics:
        return WorkflowValidationResult(ok=False, error_code="managed_resource_mismatch", diagnostics=diagnostics)

    return WorkflowValidationResult(ok=True, error_code=None, diagnostics=[])


def _load_service_config_for_validation(loaded, workflow_path: Path) -> ServiceConfig:
    raw_tracker = loaded.config.get("tracker")
    if not isinstance(raw_tracker, dict):
        raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")
    project_slug = raw_tracker.get("project_slug")
    if not str(project_slug or "").strip():
        raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")
    api_key = raw_tracker.get("api_key")
    if not str(api_key or "").strip() or str(api_key).strip().startswith("$"):
        raw_tracker = dict(raw_tracker)
        raw_tracker["api_key"] = "conductor-validation-token"
        loaded.config["tracker"] = raw_tracker
    config = ServiceConfig.from_workflow(loaded, workflow_path)
    config.validate_for_dispatch()
    return config


def _managed_resource_mismatches(instance: InstanceRecord, config: ServiceConfig) -> list[str]:
    diagnostics: list[str] = []
    if str(config.workspace.root) != instance.workspace_root:
        diagnostics.append(
            f"workspace.root must match the Conductor-managed path: {instance.workspace_root}"
        )
    if config.persistence.path is None or str(config.persistence.path) != instance.persistence_path:
        diagnostics.append(
            f"persistence.path must match the Conductor-managed path: {instance.persistence_path}"
        )
    return diagnostics


def _resource_collisions(instance: InstanceRecord, others: list[InstanceRecord]) -> list[str]:
    diagnostics: list[str] = []
    for other in others:
        if other.id == instance.id:
            continue
        if other.instance_dir == instance.instance_dir:
            diagnostics.append(f"instance_dir collides with instance {other.id}")
        if other.workspace_root == instance.workspace_root:
            diagnostics.append(f"workspace.root collides with instance {other.id}")
        if other.persistence_path == instance.persistence_path:
            diagnostics.append(f"persistence.path collides with instance {other.id}")
        if other.repo_source_type == "local_path" and other.resolved_repo_path == instance.resolved_repo_path:
            diagnostics.append(f"resolved_repo_path collides with instance {other.id}")
    return diagnostics
