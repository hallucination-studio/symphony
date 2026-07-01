from __future__ import annotations

from pathlib import Path
import tempfile

from .config import ConfigError, ServiceConfig
from .conductor_models import InstanceRecord, WorkflowValidationResult
from .workflow import WorkflowError, load_workflow


class ConductorValidationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def workflow_profiles() -> list[dict[str, str]]:
    return [
        {
            "name": "default",
            "label": "Default",
            "description": "General Symphony instance profile with managed runtime resources.",
        }
    ]


def generate_workflow_content(instance: InstanceRecord) -> str:
    if instance.workflow_profile != "default":
        raise ConductorValidationError(
            "unknown_workflow_profile",
            f"Unknown workflow profile: {instance.workflow_profile}",
        )

    goal = str(instance.workflow_inputs.get("goal") or "Move the Linear queue forward.")
    labels = instance.linear_filters.get("labels") or []
    active_states = instance.linear_filters.get("active_states") or ["Todo", "In Progress"]
    terminal_states = instance.linear_filters.get("terminal_states") or ["Closed", "Cancelled", "Canceled", "Done"]

    label_yaml = "\n".join(f"    - {label}" for label in labels) if labels else "    []"
    active_yaml = "\n".join(f"    - {state}" for state in active_states)
    terminal_yaml = "\n".join(f"    - {state}" for state in terminal_states)
    terminal_summary = ", ".join(str(state) for state in terminal_states)
    return (
        "---\n"
        "tracker:\n"
        "  kind: linear\n"
        "  endpoint: https://api.linear.app/graphql\n"
        f"  project_slug: {instance.linear_project}\n"
        "  api_key: $LINEAR_API_KEY\n"
        "  required_labels:\n"
        f"{label_yaml}\n"
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
        "  max_concurrent_agents: 10\n"
        "  max_turns: 20\n"
        "  max_retry_backoff_ms: 300000\n"
        "server:\n"
        f"  port: {instance.http_port}\n"
        "observability:\n"
        "  enabled: true\n"
        "codex:\n"
        "  command: codex app-server\n"
        "---\n"
        f'You are operating the Symphony instance "{instance.name}" for Linear project {instance.linear_project}.\n'
        f"Repository path: {instance.resolved_repo_path}\n"
        f"Instance goal: {goal}\n"
        "Work in this prepared repository workspace.\n"
        "Respect the managed workspace, persistence path, and HTTP port from this workflow.\n"
        "Use the Linear issue as the source of truth for the requested work.\n"
        "Current Linear issue:\n"
        "- Identifier: {{ issue.identifier }}\n"
        "- Issue ID: {{ issue.id }}\n"
        "- Title: {{ issue.title }}\n"
        "- URL: {{ issue.url or 'No URL provided.' }}\n"
        "- State: {{ issue.state }}\n"
        "- Description: {{ issue.description or 'No description provided.' }}\n"
        "When the requested work is implemented and verified, create a Linear comment summarizing the "
        "result and verification, then move the issue out of the active states using the linear_graphql tool.\n"
        f"Configured terminal states: {terminal_summary}.\n"
        "Prefer Done when it exists. Otherwise use the first configured terminal state.\n"
        "Use one linear_graphql call per GraphQL operation. For example:\n"
        "1. Read the current issue and its team id:\n"
        "query CurrentIssueTeam($issueId: String!) {\n"
        "  issue(id: $issueId) {\n"
        "    id\n"
        "    identifier\n"
        "    team { id key name }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\"}}\n"
        "2. Find the terminal workflow state for that team:\n"
        "query TerminalState($teamId: ID!) {\n"
        "  workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {\n"
        "    nodes { id name type }\n"
        "  }\n"
        "}\n"
        "Use the team id from the previous query for teamId.\n"
        f"variables: {{\"teamId\": \"<issue-team-id>\"}}\n"
        "Choose a state whose name matches a configured terminal state or whose type is completed/canceled.\n"
        "3. Create a completion comment with the implementation and verification summary:\n"
        "mutation CompleteIssueComment($issueId: String!, $body: String!) {\n"
        "  commentCreate(input: { issueId: $issueId, body: $body }) {\n"
        "    success\n"
        "    comment { id }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\", \"body\": \"Implemented and verified.\"}}\n"
        "4. Move the current issue to the selected terminal state:\n"
        "mutation CompleteIssue($issueId: String!, $stateId: String!) {\n"
        "  issueUpdate(id: $issueId, input: { stateId: $stateId }) {\n"
        "    success\n"
        "    issue { id identifier state { name } }\n"
        "  }\n"
        "}\n"
        f"variables: {{\"issueId\": \"{{{{ issue.id }}}}\", \"stateId\": \"<selected-state-id>\"}}\n"
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
    if config.server.port != instance.http_port:
        diagnostics.append(f"server.port must match the Conductor-managed port: {instance.http_port}")
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
        if other.http_port == instance.http_port:
            diagnostics.append(f"server.port collides with instance {other.id}")
        if other.repo_source_type == "local_path" and other.resolved_repo_path == instance.resolved_repo_path:
            diagnostics.append(f"resolved_repo_path collides with instance {other.id}")
    return diagnostics
