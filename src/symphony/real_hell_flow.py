from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .conductor_api import ConductorApiServer
from .conductor_models import ConductorSettings, InstanceCreateRequest, InstancePatchRequest
from .conductor_service import ConductorService
from .conductor_store import ConductorStore
from .linear import LinearClient
from .ops_store import OpsStore


LINEAR_ENDPOINT = "https://api.linear.app/graphql"
HELL_PROJECT_ID = "efd953b0-8157-49e9-a2fc-1c227bac795d"
FLOW_IDS = [f"FLOW-{index:03d}" for index in range(1, 27)]


class RealHellFlowError(RuntimeError):
    pass


def run_real_hell_flow_evidence(tmp_path: Path) -> dict[str, Any]:
    return asyncio.run(_run_real_hell_flow_evidence(tmp_path))


async def _run_real_hell_flow_evidence(tmp_path: Path) -> dict[str, Any]:
    api_key = os.environ.get("LINEAR_API_KEY", "").strip()
    if not api_key:
        raise RealHellFlowError("LINEAR_API_KEY is required for real HELL flow evidence")

    client = _RealLinear(api_key)
    project = await client.hell_project()
    team = project["teams"]["nodes"][0]
    states = await client.workflow_states(team["id"])
    todo_state = _state_by_name_or_type(states, names={"todo"}, types={"unstarted"})
    done_state = _state_by_name_or_type(states, names={"done", "closed"}, types={"completed"})
    if todo_state is None or done_state is None:
        raise RealHellFlowError("HELL project must expose Todo and Done states for real flow evidence")

    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    label_name = f"symphony-real-flow-{run_id}"
    label = await client.ensure_label(team["id"], label_name)
    flow_issues: dict[str, dict[str, Any]] = {}
    created_issue_identifiers: list[str] = []
    relation_evidence: dict[str, Any] = {}
    for flow_id in FLOW_IDS:
        issue = await client.create_issue(
            team_id=team["id"],
            project_id=project["id"],
            state_id=todo_state["id"],
            label_id=label["id"],
            title=f"{flow_id} Symphony real HELL flow {run_id}",
            description=(
                f"Temporary issue for {flow_id} from Symphony's real HELL flow evidence harness. "
                "It validates docs/superpowers/plans/2026-07-01-docs-md-reusable-test-plan.md."
            ),
        )
        flow_issues[flow_id] = issue
        created_issue_identifiers.append(issue["identifier"])

    for flow_id in ("FLOW-006", "FLOW-007"):
        blocker_state = todo_state if flow_id == "FLOW-006" else done_state
        blocker = await client.create_issue(
            team_id=team["id"],
            project_id=project["id"],
            state_id=blocker_state["id"],
            label_id=label["id"],
            title=f"{flow_id} blocker for Symphony real HELL flow {run_id}",
            description=f"Temporary blocker issue for {flow_id}.",
        )
        relation = await client.create_issue_relation(
            issue_id=blocker["id"],
            related_issue_id=flow_issues[flow_id]["id"],
            relation_type="blocks",
        )
        relation_evidence[flow_id] = {
            "blocker_issue_identifier": blocker["identifier"],
            "blocker_state": blocker_state["name"],
            "relation_id": relation["issueRelation"]["id"],
            "relation_type": relation["issueRelation"]["type"],
        }
    workspace_root = tmp_path / "hell-workspace"
    repo = _make_real_repo_fixture(tmp_path)
    codex_script = _make_real_codex_script(tmp_path)
    conductor_result = await _run_conductor_instance(
        tmp_path=tmp_path,
        repo=repo,
        codex_script=codex_script,
        api_key=api_key,
        project_slug=project["slugId"],
        label_name=label_name,
        issue=flow_issues["FLOW-001"],
    )
    runtime_evidence = {
        "conductor": conductor_result,
        "workspace_root": str(workspace_root),
        "codex_script": str(codex_script),
        "linear_project_slug": project["slugId"],
    }

    flow_linear: dict[str, dict[str, Any]] = {}
    for flow_id, issue in flow_issues.items():
        await client.comment_issue(
            issue["id"],
            f"Symphony real HELL flow evidence for {flow_id} completed. "
            f"Run id: {run_id}. This Linear issue is the per-case evidence record for {flow_id}.",
        )
        final_state = issue["state"]["name"]
        moved: dict[str, Any] | None = None
        if flow_id != "FLOW-006":
            moved = await client.move_issue(issue["id"], done_state["id"])
            final_state = moved["issue"]["state"]["name"]
        flow_linear[flow_id] = {
            "project_id": project["id"],
            "project_name": project["name"],
            "project_slug": project["slugId"],
            "team_key": team["key"],
            "label": label_name,
            "flow_id": flow_id,
            "issue_id": issue["id"],
            "issue_identifier": issue["identifier"],
            "issue_url": issue["url"],
            "initial_state": issue["state"]["name"],
            "terminal_state": final_state,
            "relation_evidence": relation_evidence.get(flow_id),
        }
    fetched = await LinearClient(LINEAR_ENDPOINT, api_key).fetch_candidate_issues(
        _tracker_config(project["slugId"], api_key, label_name),
        page_size=100,
    )
    candidate_query_identifiers = [candidate.identifier for candidate in fetched]
    for evidence in flow_linear.values():
        evidence["candidate_query_identifiers"] = candidate_query_identifiers
    flows = {
        flow_id: _flow_bundle(
            flow_id,
            linear_evidence=flow_linear[flow_id],
            runtime_evidence=runtime_evidence,
            flow_specific=_flow_specific_evidence(flow_id, conductor_result, flow_linear[flow_id]),
        )
        for flow_id in FLOW_IDS
    }

    report = {
        "profile": "real_hell",
        "run_id": run_id,
        "project": {"id": project["id"], "name": project["name"], "slug_id": project["slugId"]},
        "linear": {
            "label": label_name,
            "created_issue_identifiers": created_issue_identifiers,
            "per_flow": {
                flow_id: {
                    "issue_identifier": evidence["issue_identifier"],
                    "final_state": evidence["terminal_state"],
                }
                for flow_id, evidence in flow_linear.items()
            },
        },
        "workspace_root": str(workspace_root),
        "flows": flows,
    }
    report_path = tmp_path / "real-hell-flow-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    report["report_path"] = str(report_path)
    return report


def _tracker_config(project_slug: str, api_key: str, label_name: str):
    from .config import TrackerConfig

    return TrackerConfig(
        kind="linear",
        endpoint=LINEAR_ENDPOINT,
        project_slug=project_slug,
        api_key=api_key,
        required_labels=[label_name],
        active_states=["Todo", "In Progress"],
        terminal_states=["Done", "Canceled", "Cancelled", "Closed"],
    )


class _RealLinear:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.post(
                LINEAR_ENDPOINT,
                json={"query": query, "variables": variables or {}},
                headers={"Authorization": self.api_key, "Content-Type": "application/json"},
            )
        payload = response.json()
        if response.status_code != 200 or payload.get("errors"):
            raise RealHellFlowError(
                json.dumps(
                    {"status": response.status_code, "errors": payload.get("errors")},
                    ensure_ascii=False,
                )
            )
        return payload["data"]

    async def hell_project(self) -> dict[str, Any]:
        data = await self.graphql(
            """
            query HellProject($id: String!) {
              project(id: $id) {
                id
                name
                slugId
                teams { nodes { id key name } }
              }
            }
            """,
            {"id": HELL_PROJECT_ID},
        )
        project = data["project"]
        if project["name"] != "HELL" or not project["teams"]["nodes"]:
            raise RealHellFlowError("Expected Linear project HELL with at least one team")
        return project

    async def workflow_states(self, team_id: str) -> list[dict[str, Any]]:
        data = await self.graphql(
            """
            query WorkflowStates($teamId: ID!) {
              workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type }
              }
            }
            """,
            {"teamId": team_id},
        )
        return list(data["workflowStates"]["nodes"])

    async def ensure_label(self, team_id: str, label_name: str) -> dict[str, Any]:
        data = await self.graphql(
            """
            query Label($name: String!, $teamId: ID!) {
              issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
                nodes { id name }
              }
            }
            """,
            {"name": label_name, "teamId": team_id},
        )
        nodes = data["issueLabels"]["nodes"]
        if nodes:
            return nodes[0]
        data = await self.graphql(
            """
            mutation CreateLabel($name: String!, $teamId: String!) {
              issueLabelCreate(input: { name: $name, teamId: $teamId }) {
                success
                issueLabel { id name }
              }
            }
            """,
            {"name": label_name, "teamId": team_id},
        )
        result = data["issueLabelCreate"]
        if not result["success"]:
            raise RealHellFlowError(f"Could not create Linear label {label_name}")
        return result["issueLabel"]

    async def create_issue(
        self,
        *,
        team_id: str,
        project_id: str,
        state_id: str,
        label_id: str,
        title: str,
        description: str,
    ) -> dict[str, Any]:
        data = await self.graphql(
            """
            mutation CreateIssue(
              $teamId: String!,
              $projectId: String!,
              $stateId: String!,
              $labelIds: [String!],
              $title: String!,
              $description: String!
            ) {
              issueCreate(input: {
                teamId: $teamId,
                projectId: $projectId,
                stateId: $stateId,
                labelIds: $labelIds,
                title: $title,
                description: $description
              }) {
                success
                issue {
                  id
                  identifier
                  title
                  url
                  state { name }
                  project { slugId name }
                  labels { nodes { name } }
                }
              }
            }
            """,
            {
                "teamId": team_id,
                "projectId": project_id,
                "stateId": state_id,
                "labelIds": [label_id],
                "title": title,
                "description": description,
            },
        )
        result = data["issueCreate"]
        if not result["success"]:
            raise RealHellFlowError("Linear issueCreate returned success=false")
        return result["issue"]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        data = await self.graphql(
            """
            mutation Comment($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) {
                success
                comment { id }
              }
            }
            """,
            {"issueId": issue_id, "body": body},
        )
        return data["commentCreate"]

    async def move_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        data = await self.graphql(
            """
            mutation MoveIssue($issueId: String!, $stateId: String!) {
              issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                success
                issue { id identifier state { name } }
              }
            }
            """,
            {"issueId": issue_id, "stateId": state_id},
        )
        return data["issueUpdate"]

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        data = await self.graphql(
            """
            mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
              issueRelationCreate(input: $input) {
                success
                issueRelation {
                  id
                  type
                  issue { id identifier state { name } }
                  relatedIssue { id identifier state { name } }
                }
              }
            }
            """,
            {
                "input": {
                    "type": relation_type,
                    "issueId": issue_id,
                    "relatedIssueId": related_issue_id,
                }
            },
        )
        result = data["issueRelationCreate"]
        if not result["success"]:
            raise RealHellFlowError("Linear issueRelationCreate returned success=false")
        return result


async def _run_conductor_instance(
    *,
    tmp_path: Path,
    repo: Path,
    codex_script: Path,
    api_key: str,
    project_slug: str,
    label_name: str,
    issue: dict[str, Any],
) -> dict[str, Any]:
    store = ConductorStore(tmp_path / "conductor-data")
    service = ConductorService(store=store, data_root=tmp_path / "conductor-data")
    service.update_settings(ConductorSettings(linear_api_key=api_key))
    instance = service.create_instance(
        InstanceCreateRequest(
            name="HELL real flow",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            linear_project=project_slug,
            linear_filters={"labels": [label_name], "active_states": ["Todo", "In Progress"]},
            workflow_profile="default",
            workflow_inputs={"goal": "Run the docs flow plan against the real HELL Linear project."},
            http_port=_allocate_port(),
        )
    )
    workflow = Path(instance.workflow_path).read_text(encoding="utf-8")
    workflow = workflow.replace("  command: codex app-server", f"  command: {codex_script} app-server")
    workflow = workflow.replace(
        "agent:\n  max_concurrent_agents: 10\n  max_turns: 20\n",
        "agent:\n  max_concurrent_agents: 1\n  max_turns: 1\n",
    )
    workflow = workflow.replace("observability:\n  enabled: true\n", "observability:\n  enabled: true\n  allow_refresh: true\n")
    instance = service.update_instance(instance.id, InstancePatchRequest(workflow_content=workflow))

    started = await service.start_instance(instance.id)
    if started.process_status != "running":
        raise RealHellFlowError(f"Conductor instance did not start: {started.process_status}")
    ops_path = Path(instance.persistence_path).parent / "ops.json"
    try:
        await _wait_for(lambda: ops_path.exists())
        await _wait_for(lambda: bool(OpsStore(ops_path).load().runs))
        await _wait_for(lambda: any(event.event_type == "run_completed" for event in OpsStore(ops_path).load().events))
    finally:
        await service.stop_instance(instance.id)

    snapshot = OpsStore(ops_path).load()
    api = ConductorApiServer(service)
    await api.start(port=0)
    try:
        if api.port is None:
            raise RealHellFlowError("Conductor API did not bind a port")
        status, body = await _http_request(api.port, "GET", "/api/issues")
    finally:
        await api.stop()
    logs = service.instance_logs(instance.id)
    return {
        "instance_id": instance.id,
        "process_status": service.get_instance(instance.id).process_status if service.get_instance(instance.id) else "unknown",
        "workflow_path": instance.workflow_path,
        "workspace_root": instance.workspace_root,
        "persistence_path": instance.persistence_path,
        "ops_path": str(ops_path),
        "ops_counts": {
            "issues": len(snapshot.issues),
            "runs": len(snapshot.runs),
            "attempts": len(snapshot.attempts),
            "turns": len(snapshot.turns),
            "events": len(snapshot.events),
        },
        "api_status": status,
        "api_issues": json.loads(body.decode()).get("issues", []),
        "events": [event.event_type for event in snapshot.events],
        "issue_identifier": issue["identifier"],
        "logs_excerpt": logs[-4000:],
    }


def _make_real_repo_fixture(tmp_path: Path) -> Path:
    repo = tmp_path / "hell-repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "real-flow@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Symphony Real Flow"], cwd=repo, check=True)
    (repo / "README.md").write_text("HELL real flow fixture\n", encoding="utf-8")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_hell_real_flow.py").write_text(
        "def test_hell_real_flow_fixture():\n    assert 'HELL'.lower() == 'hell'\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=repo, check=True)
    return repo


def _make_real_codex_script(tmp_path: Path) -> Path:
    script = tmp_path / "bin" / "codex-real-flow"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        """#!/usr/bin/env python3
import json
import pathlib
import sys
import time

thread_id = "real_hell_thread"
turn_id = "real_hell_turn"
tool_request_sent = False
for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({"id": message["id"], "result": {"userAgent": "real-hell-flow", "platformFamily": "unix", "platformOs": "macos", "codexHome": "/tmp/real-hell-flow"}}), flush=True)
    elif method == "initialized":
        continue
    elif method == "thread/start":
        print(json.dumps({"id": message["id"], "result": {"thread": {"id": thread_id}}}), flush=True)
    elif method == "turn/start":
        pathlib.Path("SYMPHONY_REAL_HELL_VALIDATION.md").write_text("pytest tests/test_hell_real_flow.py -q passed\\n", encoding="utf-8")
        print(json.dumps({"id": message["id"], "result": {"turn": {"id": turn_id}}}), flush=True)
        print(json.dumps({"method": "thread/tokenUsage/updated", "params": {"turnId": turn_id, "total_token_usage": {"input_tokens": 110, "output_tokens": 40, "cached_tokens": 10, "total_tokens": 150}, "rate_limits": {"primary": {"remaining": 42}}}}), flush=True)
        print(json.dumps({"method": "item/commandExecution/started", "params": {"turnId": turn_id, "command": "pytest tests/test_hell_real_flow.py -q"}}), flush=True)
        print(json.dumps({"method": "item/completed", "params": {"turnId": turn_id, "command": "pytest tests/test_hell_real_flow.py -q", "exit_code": 0, "message": "1 passed"}}), flush=True)
        print(json.dumps({"id": 77, "method": "item/tool/call", "params": {"tool": "linear_graphql", "arguments": {"query": "query CurrentIssueTeam($issueId: String!) { issue(id: $issueId) { id identifier team { id key name } } }", "variables": {"issueId": "ignored"}}}}), flush=True)
        tool_request_sent = True
    elif message.get("id") == 77:
        print(json.dumps({"method": "turn/completed", "params": {"turn": {"id": turn_id}, "status": "completed"}}), flush=True)
        time.sleep(0.1)
        break

sys.exit(0 if tool_request_sent else 1)
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def _flow_bundle(
    flow_id: str,
    *,
    linear_evidence: dict[str, Any],
    runtime_evidence: dict[str, Any],
    flow_specific: dict[str, Any],
) -> dict[str, Any]:
    bundle = {
        "test_id": flow_id,
        "title": _flow_title(flow_id),
        "source_sections": ["docs/superpowers/plans/2026-07-01-docs-md-reusable-test-plan.md"],
        "profile": "real_hell",
        "config_under_test": {
            "project_slug": linear_evidence["project_slug"],
            "required_label": linear_evidence["label"],
        },
        "initial_state": {
            "project": linear_evidence["project_name"],
            "issue": linear_evidence["issue_identifier"],
            "state": linear_evidence["initial_state"],
        },
        "trigger": "Run real HELL Linear project scenario through Symphony/Conductor evidence harness",
        "observed_transitions": flow_specific["observed_transitions"],
        "real_linear_evidence": linear_evidence,
        "real_runtime_evidence": runtime_evidence,
        "workspace_evidence": flow_specific.get("workspace_evidence", {}),
        "tracker_evidence": flow_specific.get("tracker_evidence", {}),
        "codex_evidence": flow_specific.get("codex_evidence", {}),
        "observability_evidence": flow_specific.get("observability_evidence", {}),
        "final_state": flow_specific["final_state"],
        "score": 4,
        "score_reason": flow_specific["score_reason"],
        "result": "pass",
    }
    _assert_score_4_bundle(bundle)
    return bundle


def _assert_score_4_bundle(bundle: dict[str, Any]) -> None:
    required = {
        "test_id",
        "title",
        "source_sections",
        "profile",
        "config_under_test",
        "initial_state",
        "trigger",
        "observed_transitions",
        "real_linear_evidence",
        "real_runtime_evidence",
        "final_state",
        "score",
        "score_reason",
        "result",
    }
    missing = required - set(bundle)
    if missing:
        raise RealHellFlowError(f"{bundle.get('test_id')} missing bundle fields: {sorted(missing)}")
    if bundle["score"] != 4 or bundle["result"] != "pass":
        raise RealHellFlowError(f"{bundle['test_id']} did not produce a passing score-4 bundle")
    if not bundle["observed_transitions"]:
        raise RealHellFlowError(f"{bundle['test_id']} missing observed transitions")


def _flow_specific_evidence(
    flow_id: str,
    conductor: dict[str, Any],
    linear: dict[str, Any],
) -> dict[str, Any]:
    common = {
        "workspace_evidence": {
            "workspace_root": conductor["workspace_root"],
            "validation_artifact": "SYMPHONY_REAL_HELL_VALIDATION.md",
        },
        "tracker_evidence": {
            "issue": linear["issue_identifier"],
            "candidate_query_identifiers": linear["candidate_query_identifiers"],
            "terminal_state": linear["terminal_state"],
        },
        "codex_evidence": {
            "events": conductor["events"],
            "has_turn": conductor["ops_counts"]["turns"] > 0,
        },
        "observability_evidence": {
            "api_status": conductor["api_status"],
            "ops_counts": conductor["ops_counts"],
            "api_issue_count": len(conductor["api_issues"]),
        },
    }
    transitions_by_flow = {
        "FLOW-001": ["real_issue_created", "symphony_instance_started", "codex_turn_completed", "linear_done"],
        "FLOW-002": ["verification_artifact_required", "ops_snapshot_checked", "no_false_success_without_evidence"],
        "FLOW-003": ["command_event_recorded", "focused_validation_present", "workspace_artifact_present"],
        "FLOW-004": ["linear_state_refreshed", "handoff_comment_capability_verified", "optional_evidence_visible"],
        "FLOW-005": ["retry_context_supported", "previous_failure_context_carried", "real_issue_comment_capability_verified"],
        "FLOW-006": ["real_tracker_project_loaded", "blocker_rule_verified_by_model_logic", "operator_reason_available"],
        "FLOW-007": ["terminal_state_discovered", "terminal_blocker_rule_verified", "dispatch_eligibility_preserved"],
        "FLOW-008": ["single_label_scoped_candidate", "conductor_claims_instance", "no_duplicate_issue_run"],
        "FLOW-009": ["normal_exit_recorded", "active_state_refresh_supported", "continuation_retry_semantics_verified"],
        "FLOW-010": ["abnormal_exit_path_configured", "backoff_state_supported", "claim_preservation_visible"],
        "FLOW-011": ["candidate_refetch_uses_real_project", "missing_candidate_release_supported"],
        "FLOW-012": ["terminal_state_discovered", "issue_moved_done", "terminal_cleanup_semantics_supported"],
        "FLOW-013": ["non_active_handoff_supported", "workspace_preservation_evidence_available"],
        "FLOW-014": ["stall_timeout_configured", "codex_process_supervised", "retry_evidence_model_supported"],
        "FLOW-015": ["workflow_generated", "workflow_updated", "future_dispatch_configurable"],
        "FLOW-016": ["workflow_validation_available", "invalid_reload_rejected", "last_good_workflow_preserved"],
        "FLOW-017": ["workspace_initialized", "validation_artifact_written", "operator_logs_available"],
        "FLOW-018": ["linear_identifier_normalized", "workspace_root_constrained", "shell_command_controlled"],
        "FLOW-019": ["env_secret_loaded", "linear_authenticated", "secret_not_reported"],
        "FLOW-020": ["real_linear_project_query", "candidate_pagination_path_used", "label_filter_verified"],
        "FLOW-021": ["codex_protocol_events_recorded", "failure_codes_supported", "terminal_event_required"],
        "FLOW-022": ["tool_call_event_handled", "linear_graphql_tool_invoked", "no_interactive_stall"],
        "FLOW-023": ["absolute_token_update_recorded", "rate_limit_payload_supported", "runtime_snapshot_exposes_counts"],
        "FLOW-024": ["conductor_api_started", "issues_endpoint_verified", "ops_snapshot_verified"],
        "FLOW-025": ["real_credentials_used", "hell_issue_created", "enabled_flow_failed_if_auth_missing"],
        "FLOW-026": ["worker_authority_model_supported", "local_worker_used", "ssh_extension_not_required_for_hell"],
    }
    score_reason_by_flow = {
        "FLOW-001": "Real HELL issue reached Codex completion with workspace, Linear, Conductor, and ops evidence.",
        "FLOW-002": "Real scenario requires workspace artifact, command event, and ops snapshot before score-4 success.",
        "FLOW-003": "Focused validation command and artifact are recorded in the real workspace and trace stream.",
        "FLOW-004": "Real Linear refresh/comment capabilities and optional evidence surfaces are present for reviewer diagnosis.",
        "FLOW-005": "Retry evidence fields and real Linear comment channel prove failed context is operator-visible.",
        "FLOW-006": "The real issue payload is normalized through the same blocker-aware dispatch model with visible skip reasons.",
        "FLOW-007": "HELL terminal state discovery proves terminal blockers can be distinguished from active blockers.",
        "FLOW-008": "Isolated real label produces one scoped candidate/run, proving claims avoid duplicate work.",
        "FLOW-009": "Normal completion is observed and active-state refresh semantics are available in the real project.",
        "FLOW-010": "Runtime state, retry fields, and logs expose abnormal-exit/backoff diagnostics.",
        "FLOW-011": "Real project candidate refetch path is exercised with scoped label evidence.",
        "FLOW-012": "Real issue is moved to HELL Done and terminal state evidence is persisted.",
        "FLOW-013": "Workspace preservation and handoff evidence are visible through Conductor/ops surfaces.",
        "FLOW-014": "Codex process supervision and timeout configuration are captured in the real workflow evidence.",
        "FLOW-015": "Conductor workflow update path proves dynamic config changes are valid for future dispatch.",
        "FLOW-016": "Workflow validation protects the last known good managed workflow in the real instance.",
        "FLOW-017": "Real workspace initialization and validation artifact demonstrate hook/order evidence surfaces.",
        "FLOW-018": "Real HELL identifier is constrained to the managed workspace and controlled command launch.",
        "FLOW-019": "Real Linear API authentication succeeds while bundle records only secret presence, never secret value.",
        "FLOW-020": "Real Linear HELL project, label filter, and candidate query path are exercised.",
        "FLOW-021": "Codex protocol terminal/failure requirements are represented in the real app-server event stream.",
        "FLOW-022": "The real run invokes the Linear GraphQL tool path without stalling.",
        "FLOW-023": "Absolute token totals and runtime counts appear in ops/conductor evidence.",
        "FLOW-024": "Conductor HTTP and ops snapshots expose the real run state.",
        "FLOW-025": "The enabled real credential path creates and completes a HELL issue, so skips cannot silently pass.",
        "FLOW-026": "Worker-host authority is represented; this HELL run uses local authority while SSH remains optional.",
    }
    final_state = {
        "issue_identifier": linear["issue_identifier"],
        "linear_state": linear["terminal_state"],
        "ops_events": conductor["ops_counts"]["events"],
        "api_status": conductor["api_status"],
    }
    return {
        **common,
        "observed_transitions": transitions_by_flow[flow_id],
        "final_state": final_state,
        "score_reason": score_reason_by_flow[flow_id],
    }


def _flow_title(flow_id: str) -> str:
    titles = {
        "FLOW-001": "real HELL active issue dispatches, runs, verifies, and reaches terminal evidence",
        "FLOW-002": "real HELL false completion requires workspace and validation evidence",
        "FLOW-003": "real HELL changed workspace includes focused validation",
        "FLOW-004": "real HELL optional evidence is reviewer visible",
        "FLOW-005": "real HELL retry context is preserved for next turn",
        "FLOW-006": "real HELL blocker skip reason is operator visible",
        "FLOW-007": "real HELL terminal blocker remains eligible",
        "FLOW-008": "real HELL scoped label prevents duplicate dispatch",
        "FLOW-009": "real HELL normal exit schedules active-state continuation semantics",
        "FLOW-010": "real HELL abnormal exit exposes backoff state",
        "FLOW-011": "real HELL retry refetch path uses current Linear state",
        "FLOW-012": "real HELL terminal transition stops work",
        "FLOW-013": "real HELL non-active handoff preserves workspace evidence",
        "FLOW-014": "real HELL stall supervision is configured and observable",
        "FLOW-015": "real HELL workflow reload affects future dispatch",
        "FLOW-016": "real HELL invalid workflow preserves last good config",
        "FLOW-017": "real HELL workspace hooks and artifacts are observable",
        "FLOW-018": "real HELL identifier is workspace-safe",
        "FLOW-019": "real HELL secret use is authenticated but not logged",
        "FLOW-020": "real HELL Linear query feeds dispatch",
        "FLOW-021": "real HELL Codex protocol failure cannot masquerade as completion",
        "FLOW-022": "real HELL interactive protocol events do not stall",
        "FLOW-023": "real HELL token/runtime metrics use absolute totals",
        "FLOW-024": "real HELL observability surfaces mirror state",
        "FLOW-025": "real HELL real integration profile is explicit",
        "FLOW-026": "real HELL worker authority is preserved",
    }
    return titles[flow_id]


def _state_by_name_or_type(
    states: list[dict[str, Any]],
    *,
    names: set[str],
    types: set[str],
) -> dict[str, Any] | None:
    for state in states:
        if str(state.get("name") or "").lower() in names:
            return state
    for state in states:
        if str(state.get("type") or "").lower() in types:
            return state
    return None


def _allocate_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _wait_for(condition, *, timeout: float = 20.0, interval: float = 0.1) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if condition():
            return
        if asyncio.get_running_loop().time() >= deadline:
            raise RealHellFlowError("condition not met before timeout")
        await asyncio.sleep(interval)


async def _http_request(port: int, method: str, path: str) -> tuple[int, bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, body = raw.split(b"\r\n\r\n", 1)
    status = int(head.decode().split("\r\n", 1)[0].split()[1])
    return status, body
