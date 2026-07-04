from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


LINEAR_ENDPOINT = "https://api.linear.app/graphql"
DEFAULT_PROJECT_SLUG = "d17d2f7a038d"


@dataclass
class ManagedProcess:
    name: str
    process: subprocess.Popen[bytes]

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGINT)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class Evidence:
    def __init__(self, out: Path) -> None:
        self.out = out
        self.data: dict[str, Any] = {
            "started_at": utc_now(),
            "checks": [],
            "artifacts": {},
            "failures": [],
        }

    def check(self, name: str, passed: bool, **details: Any) -> None:
        row = {"name": name, "passed": passed, **details}
        self.data["checks"].append(row)
        if not passed:
            self.data["failures"].append(row)
        self.write()

    def artifact(self, name: str, path: Path) -> None:
        self.data["artifacts"][name] = str(path)
        self.write()

    def write(self) -> None:
        self.out.parent.mkdir(parents=True, exist_ok=True)
        self.data["updated_at"] = utc_now()
        self.out.write_text(json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def allocate_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | bytes | None = None,
    *,
    timeout: int = 30,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    if isinstance(payload, bytes):
        body = payload
    else:
        body = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
            if not raw:
                return response.status, None
            try:
                return response.status, json.loads(raw)
            except json.JSONDecodeError:
                return response.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return exc.code, parsed


def read_json_object_if_ready(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return payload if isinstance(payload, dict) else default


async def linear_graphql(token: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    last_error: Exception | None = None
    max_attempts = 8
    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=45, trust_env=False) as client:
                response = await client.post(
                    LINEAR_ENDPOINT,
                    json={"query": query, "variables": variables},
                    headers={"Authorization": token, "Content-Type": "application/json"},
                )
            payload = response.json()
            if response.status_code != 200 or payload.get("errors"):
                raise RuntimeError(json.dumps({"status": response.status_code, "payload": payload}, indent=2))
            return payload["data"]
        except (httpx.HTTPError, TimeoutError) as exc:
            last_error = exc
            if attempt == max_attempts:
                break
            await asyncio.sleep(min(2 ** (attempt - 1), 20))
    raise RuntimeError(f"Linear GraphQL request failed after retries: {last_error!r}") from last_error


async def fetch_linear_viewer(token: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query Viewer {
              viewer { id name email }
            }
            """,
            {},
        )
    )["viewer"]


async def create_linear_issue(
    token: str, project_slug: str, run_id: str, *, delegate_id: str | None = None
) -> dict[str, Any]:
    project = (
        await linear_graphql(
            token,
            """
            query Project($slug: String!) {
              projects(first: 5, filter: { slugId: { eq: $slug } }) {
                nodes { id name slugId teams { nodes { id key name } } }
              }
            }
            """,
            {"slug": project_slug},
        )
    )["projects"]["nodes"][0]
    team = project["teams"]["nodes"][0]
    states = (
        await linear_graphql(
            token,
            """
            query States($teamId: ID!) {
              workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type }
              }
            }
            """,
            {"teamId": team["id"]},
        )
    )["workflowStates"]["nodes"]
    todo = next((state for state in states if state["name"].lower() == "todo"), None)
    if todo is None:
        todo = next(state for state in states if state["type"] == "unstarted")
    issue = (
        await linear_graphql(
            token,
            """
            mutation CreateIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  url
                  state { name type }
                  assignee { id name }
                  delegate { id name }
                  agentSessions(first: 5) { nodes { id status appUser { id name } } }
                  labels { nodes { name } }
                }
              }
            }
            """,
            {
                "input": {
                    "teamId": team["id"],
                    "projectId": project["id"],
                    "stateId": todo["id"],
                    "title": f"Symphony managed agent dispatch {run_id}",
                    "description": (
                        "Real Symphony e2e task. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, "
                        "include this Linear issue identifier, say Podium, Conductor, and Performer reached Codex, "
                        "and run pytest tests/test_smoke.py -q."
                    ),
                    **({"delegateId": delegate_id} if delegate_id else {}),
                }
            },
        )
    )["issueCreate"]["issue"]
    return {"project": project, "team": team, "todo_state": todo, "issue": issue}


async def fetch_linear_issue(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query Issue($id: String!) {
              issue(id: $id) {
                id
                identifier
                title
                url
                state { name type }
                assignee { id name }
                delegate { id name }
                agentSessions(first: 5) { nodes { id status appUser { id name } } }
                labels { nodes { name } }
                comments(first: 20) { nodes { body createdAt } }
              }
            }
            """,
            {"id": issue_id},
        )
    )["issue"]


async def delegate_linear_issue(token: str, issue_id: str, delegate_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation DelegateIssue($issueId: String!, $delegateId: String!) {
              issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
                success
                issue {
                  id
                  identifier
                  delegate { id name }
                  agentSessions(first: 5) { nodes { id status appUser { id name } } }
                }
              }
            }
            """,
            {"issueId": issue_id, "delegateId": delegate_id},
        )
    )["issueUpdate"]["issue"]


async def comment_linear_issue(token: str, issue_id: str, body: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation CommentIssue($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) {
                success
                comment { id }
              }
            }
            """,
            {"issueId": issue_id, "body": body},
        )
    )["commentCreate"]


async def fetch_linear_human_action_issue(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query HumanActionIssue($issueId: String!) {
              issue(id: $issueId) {
                id
                identifier
                description
                state { name type }
                team {
                  states(first: 50) {
                    nodes { id name type }
                  }
                }
              }
            }
            """,
            {"issueId": issue_id},
        )
    )["issue"]


async def update_linear_issue_description(token: str, issue_id: str, description: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation UpdateHumanActionDescription($issueId: String!, $description: String!) {
              issueUpdate(id: $issueId, input: { description: $description }) {
                success
                issue { id identifier }
              }
            }
            """,
            {"issueId": issue_id, "description": description},
        )
    )["issueUpdate"]


async def move_linear_issue_to_state(token: str, issue_id: str, state_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation MoveHumanActionIssue($issueId: String!, $stateId: String!) {
              issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                success
                issue { id identifier state { name type } }
              }
            }
            """,
            {"issueId": issue_id, "stateId": state_id},
        )
    )["issueUpdate"]


async def fetch_linear_issue_tree(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query IssueTree($id: String!) {
              issue(id: $id) {
                id
                identifier
                title
                url
                state { name type }
                assignee { id name }
                delegate { id name }
                agentSessions(first: 5) { nodes { id status appUser { id name } } }
                labels { nodes { name } }
                children(first: 50) {
                  nodes {
                    id
                    identifier
                    title
                    state { name type }
                    delegate { id name }
                    labels { nodes { name } }
                    comments(first: 20) { nodes { body createdAt } }
                    children(first: 50) {
                      nodes {
                        id
                        identifier
                        title
                        state { name type }
                        delegate { id name }
                        labels { nodes { name } }
                        comments(first: 20) { nodes { body createdAt } }
                      }
                    }
                  }
                }
                comments(first: 20) { nodes { body createdAt } }
              }
            }
            """,
            {"id": issue_id},
        )
    )["issue"]


def run_cmd(name: str, command: list[str], evidence: Evidence, *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, env=env, timeout=60)
    evidence.check(
        f"cli:{name}",
        result.returncode == 0,
        command=command[:3],
        stdout_tail=result.stdout[-500:],
        stderr_tail=result.stderr[-500:],
        returncode=result.returncode,
    )
    return result


def start_process(name: str, command: list[str], *, env: dict[str, str], stdout_path: Path) -> ManagedProcess:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    handle = stdout_path.open("ab")
    process = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT, env=env)
    return ManagedProcess(name=name, process=process)


async def wait_for_http_ready(url: str, *, timeout_seconds: float = 10.0) -> tuple[int, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            status, body = http_json("GET", url, timeout=2)
            return status, body
        except urllib.error.URLError as exc:
            last_error = str(exc)
        await asyncio.sleep(0.2)
    raise RuntimeError(f"HTTP service not ready at {url}: {last_error or 'timed out'}")


def make_fixture_repo(path: Path) -> Path:
    if path.exists():
        subprocess.run(["rm", "-rf", str(path)], check=True)
    (path / "tests").mkdir(parents=True)
    (path / "pyproject.toml").write_text('[tool.pytest.ini_options]\ntestpaths = ["tests"]\n', encoding="utf-8")
    (path / "tests" / "test_smoke.py").write_text("def test_smoke_fixture():\n    assert True\n", encoding="utf-8")
    (path / "README.md").write_text("Symphony real e2e fixture.\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "real-e2e@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Symphony Real E2E"], cwd=path, check=True)
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)
    return path


def patch_workflow(workflow_path: Path, *, acceptance_gates: bool, permission_approval_probe: bool = False) -> str:
    workflow = workflow_path.read_text(encoding="utf-8")
    codex_bin = shutil.which("codex")
    if codex_bin and "  sdk_codex_bin:" not in workflow:
        workflow = workflow.replace("codex:\n", f"codex:\n  sdk_codex_bin: {codex_bin}\n", 1)
    workflow = workflow.replace(
        "  max_concurrent_agents: 10\n  max_turns: 20\n",
        "  max_concurrent_agents: 1\n  max_turns: 2\n" if acceptance_gates else "  max_concurrent_agents: 1\n  max_turns: 1\n",
    )
    if "polling:\n" not in workflow:
        workflow = workflow.replace("persistence:\n", "polling:\n  interval_ms: 5000\n\npersistence:\n")
    if "completion_verification:\n" not in workflow:
        workflow = workflow.replace(
            "codex:\n",
            "completion_verification:\n"
            "  expected_test_patterns:\n"
            "    - tests/test_smoke.py\n"
            "  min_workspace_changes_chars: 10\n\n"
            "codex:\n",
        )
    if acceptance_gates and "acceptance:\n" not in workflow:
        workflow = workflow.replace(
            "codex:\n",
            "acceptance:\n"
            "  enabled: true\n"
            "  mode: block_done\n"
            "  minimum_score: 3\n"
            "  require_findings_for_score_3: true\n"
            "  auto_retry_on_fail: true\n"
            "  todo_state: Todo\n"
            "  implementation_state: In Progress\n"
            "  review_state: In Review\n"
            "  done_state: Done\n\n"
            "codex:\n",
        )
    if not acceptance_gates and "acceptance:\n" in workflow:
        workflow = workflow.replace("  enabled: true\n", "  enabled: false\n", 1)
    if permission_approval_probe:
        task_instruction = (
            "E2E permission approval probe: First check whether `.symphony_permission_probe_started` exists in the current working directory returned by `pwd`. "
            "If it does not exist, create `.symphony_permission_probe_started` in `pwd`, then intentionally try to create `SYMPHONY_PERMISSION_DENIED_PROBE.md` "
            "under the Source repository path shown above, outside `pwd`. Stop after that attempted outside-workspace write; do not create the result file yet. "
            "If `.symphony_permission_probe_started` already exists, do not write outside `pwd`; create SYMPHONY_REAL_E2E_RESULT.md in `pwd`. "
            "The result file must include the Linear issue identifier and one sentence saying Podium, Conductor, Performer, and Linear approval resumed successfully. "
            "Run `pytest tests/test_smoke.py -q`. "
        )
    else:
        task_instruction = (
            "E2E task: Create SYMPHONY_REAL_E2E_RESULT.md in the current working directory returned by `pwd`; do not write to any source repository path outside `pwd`. The file must include the Linear issue identifier "
            "and one sentence saying Podium, Conductor, and Performer reached Codex successfully. Run `pytest tests/test_smoke.py -q`. "
            "Do not inspect git status, do not clean pytest caches, and do not remove generated `__pycache__`; those are outside this task's acceptance criteria. "
        )
    if acceptance_gates:
        task_instruction += (
            "Update the Linear issue description with concrete evidence fields named exactly `Implementation summary:`, "
            "`Test commands and exact output:`, and `Remaining risks:`. Do not move the issue to Done yourself; leave it active "
            "so Performer can run acceptance gates.\n"
        )
    else:
        task_instruction += "Let Performer handle completion policy.\n"
    legacy_instruction = (
        "When the requested work is implemented and verified, create a Linear comment summarizing the result and verification, "
        "then move the issue out of the active states using the linear_graphql tool.\n"
    )
    if legacy_instruction in workflow:
        workflow = workflow.replace(legacy_instruction, task_instruction)
    elif "Current Linear issue:\n" in workflow and task_instruction not in workflow:
        workflow += "\n" + task_instruction
    if acceptance_gates and "Configured terminal states:" in workflow:
        workflow = workflow.split("Configured terminal states:", 1)[0]
        workflow += (
            "Acceptance gates are enabled. After implementation, leave the business issue in an active state with the required evidence fields in its description. "
            "Performer will move it to review, run the gate child issue, create evidence, and close the tree if the gate passes.\n"
        )
    return workflow


def patch_e2e_gate_mode(workflow: str, *, gate_mode: str) -> str:
    if gate_mode not in {"smoke", "strict"}:
        raise ValueError(f"unsupported e2e gate mode: {gate_mode}")
    if "acceptance:\n" not in workflow:
        return workflow
    lines = workflow.splitlines()
    output: list[str] = []
    in_acceptance = False
    inserted = False
    for line in lines:
        if line.startswith("acceptance:"):
            in_acceptance = True
            inserted = False
            output.append(line)
            continue
        if in_acceptance and line == "" and not inserted:
            output.append(f"  gate_planner_mode: {gate_mode}")
            inserted = True
        if in_acceptance and line and not line.startswith(" "):
            if not inserted:
                output.append(f"  gate_planner_mode: {gate_mode}")
                inserted = True
            in_acceptance = False
        if in_acceptance and line.strip().startswith("gate_planner_mode:"):
            if not inserted:
                output.append(f"  gate_planner_mode: {gate_mode}")
                inserted = True
            continue
        output.append(line)
    if in_acceptance and not inserted:
        output.append(f"  gate_planner_mode: {gate_mode}")
    return "\n".join(output) + ("\n" if workflow.endswith("\n") else "")


def api_url(port: int, path: str) -> str:
    return f"http://127.0.0.1:{port}{path}"


def write_wait_artifacts(
    *,
    evidence: Evidence,
    samples: list[dict[str, Any]],
    result_path: Path,
    final_issue: dict[str, Any],
    state_path: Path,
    last_state: dict[str, Any],
    ops_path: Path,
    last_ops: dict[str, Any],
    log_path: Path,
    stages: dict[str, str],
    stage_timeout_seconds: int,
) -> dict[str, Any]:
    samples_path = evidence.out.parent / "runtime-samples.json"
    samples_path.write_text(json.dumps(samples, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("runtime_samples", samples_path)
    if result_path.exists():
        result_copy = evidence.out.parent / "workspace-result.txt"
        result_copy.write_text(result_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        evidence.artifact("workspace_result", result_copy)
    final_issue_path = evidence.out.parent / "final-issue.json"
    final_issue_path.write_text(json.dumps(final_issue, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("final_issue", final_issue_path)
    stage_snapshot = {
        "observed": stages,
        "stage_timeout_seconds": stage_timeout_seconds,
        "last_sample": samples[-1] if samples else None,
    }
    stage_snapshot_path = evidence.out.parent / "stage-snapshot.json"
    stage_snapshot_path.write_text(json.dumps(stage_snapshot, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("stage_snapshot", stage_snapshot_path)
    return {
        "state": read_json_object_if_ready(state_path, last_state),
        "ops": read_json_object_if_ready(ops_path, last_ops),
        "issue": final_issue,
        "result_path": str(result_path),
        "log_path": str(log_path),
        "samples": samples,
    }


def conductor_human_actions(runs_payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs = runs_payload.get("runs")
    if not isinstance(runs, list):
        return []
    actions: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict) or run.get("phase") != "awaiting_human":
            continue
        human_action = run.get("human_action")
        if not isinstance(human_action, dict):
            human_action = {}
        actions.append(
            {
                "run_id": str(run.get("run_id") or ""),
                "issue_id": str(run.get("issue_id") or ""),
                "issue_identifier": str(run.get("issue_identifier") or "") or None,
                "phase": str(run.get("phase") or ""),
                "status": str(run.get("status") or ""),
                "last_reason": str(run.get("last_reason") or "") or None,
                "child_issue_id": str(human_action.get("child_issue_id") or "") or None,
                "child_identifier": str(human_action.get("child_identifier") or "") or None,
                "child_url": str(human_action.get("child_url") or "") or None,
                "kind": str(human_action.get("kind") or "") or None,
            }
        )
    return actions


def human_action_description_with_response(description: str, response: str) -> str:
    marker = "Human response:"
    response = response.strip()
    if marker.lower() not in description.lower():
        return f"{description.rstrip()}\n\n{marker}\n{response}\n"
    lower = description.lower()
    start = lower.find(marker.lower()) + len(marker)
    stop = len(description)
    for candidate in ["When finished,", "完成后", "Move this child issue"]:
        index = lower.find(candidate.lower(), start)
        if index >= 0:
            stop = min(stop, index)
    prefix = description[:start].rstrip()
    suffix = description[stop:].lstrip("\n")
    if suffix:
        return f"{prefix}\n{response}\n\n{suffix}"
    return f"{prefix}\n{response}\n"


def should_complete_conductor_human_action(action: dict[str, Any], completed_run_ids: set[str]) -> bool:
    run_id = str(action.get("run_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    return bool(run_id and child_issue_id and run_id not in completed_run_ids)


def done_state_id_for_human_action(issue: dict[str, Any]) -> str | None:
    team = issue.get("team") if isinstance(issue.get("team"), dict) else {}
    states = ((team.get("states") or {}).get("nodes") or []) if isinstance(team, dict) else []
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("type") or "") == "completed" and state.get("id"):
            return str(state["id"])
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("name") or "").strip().lower() == "done" and state.get("id"):
            return str(state["id"])
    return None


async def complete_conductor_human_action(
    token: str,
    action: dict[str, Any],
    *,
    response: str,
) -> dict[str, Any]:
    child_issue_id = str(action.get("child_issue_id") or "").strip()
    if not child_issue_id:
        return {"status": "skipped", "reason": "missing_child_issue_id", "action": action}
    issue = await fetch_linear_human_action_issue(token, child_issue_id)
    state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
    if str(state.get("type") or "") == "completed" or str(state.get("name") or "").strip().lower() == "done":
        return {"status": "already_done", "child_issue_id": child_issue_id, "child_identifier": issue.get("identifier")}
    description = human_action_description_with_response(str(issue.get("description") or ""), response)
    updated = await update_linear_issue_description(token, child_issue_id, description)
    done_state_id = done_state_id_for_human_action(issue)
    if not done_state_id:
        return {
            "status": "failed",
            "reason": "done_state_not_found",
            "child_issue_id": child_issue_id,
            "description_updated": bool(updated.get("success")),
        }
    moved = await move_linear_issue_to_state(token, child_issue_id, done_state_id)
    moved_issue = moved.get("issue") if isinstance(moved, dict) and isinstance(moved.get("issue"), dict) else {}
    return {
        "status": "completed" if moved.get("success") else "failed",
        "child_issue_id": child_issue_id,
        "child_identifier": moved_issue.get("identifier") or issue.get("identifier"),
        "description_updated": bool(updated.get("success")),
        "state": moved_issue.get("state"),
    }


def linear_webhook_signature(secret: str, payload: bytes) -> str:
    import hashlib
    import hmac

    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


async def wait_for_run(
    *,
    token: str,
    issue_id: str,
    instance: dict[str, Any],
    conductor_port: int,
    evidence: Evidence,
    timeout_seconds: int,
    stage_timeout_seconds: int,
    permission_approval_probe: bool = False,
) -> dict[str, Any]:
    instance_root = Path(instance["instance_dir"])
    state_path = Path(instance["persistence_path"])
    ops_path = state_path.parent / "ops.json"
    result_path = Path(instance["workspace_root"]) / "SYMPHONY_REAL_E2E_RESULT.md"
    log_path = Path(instance["log_path"])
    instance_id = str(instance["id"])
    deadline = time.monotonic() + timeout_seconds
    samples: list[dict[str, Any]] = []
    final_issue: dict[str, Any] | None = None
    approved_blocked_events: set[str] = set()
    completed_phase_human_actions: set[str] = set()
    completed_phase_human_runs: set[str] = set()
    last_state: dict[str, Any] = {}
    last_ops: dict[str, Any] = {}
    stages: dict[str, str] = {}

    def mark_stage(name: str, passed: bool, **details: Any) -> None:
        if passed and name not in stages:
            stages[name] = utc_now()
            evidence.check(f"stage:{name}", True, **details)

    while time.monotonic() < deadline:
        if not log_path.exists():
            generated = sorted((instance_root / "logs").glob("performer-*.log"))
            if generated:
                log_path = generated[-1]
        last_state = read_json_object_if_ready(state_path, last_state)
        last_ops = read_json_object_if_ready(ops_path, last_ops)
        state = last_state
        ops = last_ops
        try:
            final_issue = await fetch_linear_issue(token, issue_id)
        except RuntimeError as exc:
            samples.append(
                {
                    "at": utc_now(),
                    "issue_state": "unknown",
                    "process_status": "unknown",
                    "linear_fetch_error": str(exc),
                }
            )
            await asyncio.sleep(5)
            continue
        status, runtime_body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"), timeout=2)
        process_status = None
        if status == 200 and isinstance(runtime_body, dict):
            process_status = (runtime_body.get("instance") or {}).get("process_status")
        runs_status, runs_body = http_json("GET", api_url(conductor_port, "/api/runs"), timeout=2)
        phase_human_actions = conductor_human_actions(runs_body if runs_status == 200 and isinstance(runs_body, dict) else {})
        run_statuses = [run.get("status") for run in ops.get("runs", {}).values()]
        event_types = [
            event.get("event_type")
            for event in ops.get("events", {}).values()
            if isinstance(event, dict)
        ] if isinstance(ops.get("events"), dict) else [
            event.get("event_type")
            for event in ops.get("events", [])
            if isinstance(event, dict)
        ]
        sample = {
            "at": utc_now(),
            "issue_state": final_issue["state"]["name"],
            "process_status": process_status,
            "sessions": len(state.get("sessions", [])),
            "retry_attempts": len(state.get("retry_attempts", [])),
            "continuations": len(state.get("continuations", [])),
            "blocked": len(state.get("blocked", [])),
            "result_exists": result_path.exists(),
            "run_statuses": run_statuses,
            "phase_human_actions": phase_human_actions,
            "event_types": event_types[-20:],
        }
        samples.append(sample)
        mark_stage("webhook_queued", True, issue_id=issue_id)
        mark_stage("process_running_or_exited", process_status in {"running", "exited", "stopped"}, process_status=process_status)
        mark_stage("implementation_result_exists", result_path.exists(), path=str(result_path))
        mark_stage(
            "implementation_review_ready",
            final_issue["state"]["name"] == "In Review" or final_issue["state"]["type"] in {"completed", "canceled"},
            issue_state=final_issue["state"],
        )
        mark_stage(
            "gate_followup_started",
            "gate_followup_started" in event_types,
            event_types=event_types[-20:],
        )
        mark_stage(
            "gate_one_shot_completed",
            "gate_followup_started" in event_types and run_statuses and all(status != "running" for status in run_statuses),
            run_statuses=run_statuses,
        )
        blocked = [entry for entry in state.get("blocked", []) if isinstance(entry, dict)]
        for blocked_entry in blocked:
            blocked_issue_id = str(blocked_entry.get("issue_id") or "")
            blocked_key = f"{blocked_issue_id}:{blocked_entry.get('blocked_at') or blocked_entry.get('error')}"
            if not blocked_issue_id or blocked_key in approved_blocked_events:
                continue
            evidence.check(
                "runtime-error:blocked-visible",
                blocked_entry.get("phase") == "error"
                and blocked_entry.get("status_label") == "performer:phase/blocked"
                and bool(blocked_entry.get("error")),
                blocked=blocked_entry,
            )
            approval_comment = f"/symphony approve-runtime-error {blocked_entry.get('issue_identifier') or blocked_issue_id}"
            body = await comment_linear_issue(
                token,
                blocked_issue_id,
                approval_comment,
            )
            evidence.check(
                "runtime-error:linear-human-approved-resume",
                bool(body.get("success")) and bool((body.get("comment") or {}).get("id")),
                approval_comment=approval_comment,
                body=body,
            )
            approved_blocked_events.add(blocked_key)
            await asyncio.sleep(2)
            break
        if phase_human_actions:
            evidence.check(
                "human-action:conductor-phase-awaiting-human",
                True,
                actions=phase_human_actions,
            )
            for action in phase_human_actions:
                run_id = str(action.get("run_id") or "")
                child_issue_id = str(action.get("child_issue_id") or "")
                if run_id in completed_phase_human_runs and child_issue_id not in completed_phase_human_actions:
                    evidence.check(
                        "human-action:repeat-awaiting-human-after-resume",
                        False,
                        action=action,
                        reason="same Conductor run requested another human action after automatic resume",
                    )
                    return write_wait_artifacts(
                        evidence=evidence,
                        samples=samples,
                        result_path=result_path,
                        final_issue=final_issue,
                        state_path=state_path,
                        last_state=last_state,
                        ops_path=ops_path,
                        last_ops=last_ops,
                        log_path=log_path,
                        stages=stages,
                        stage_timeout_seconds=stage_timeout_seconds,
                    )
                if not should_complete_conductor_human_action(action, completed_phase_human_runs):
                    continue
                response = (
                    "Reviewed by the real Symphony E2E harness. "
                    "Apply any required local environment fix and retry the managed run."
                )
                try:
                    completion = await complete_conductor_human_action(token, action, response=response)
                except Exception as exc:
                    evidence.check(
                        "human-action:linear-child-complete",
                        False,
                        child_issue_id=child_issue_id,
                        error=str(exc),
                    )
                    continue
                completed_phase_human_actions.add(child_issue_id)
                completed_phase_human_runs.add(run_id)
                evidence.check(
                    "human-action:linear-child-complete",
                    completion.get("status") in {"completed", "already_done"},
                    action=action,
                    completion=completion,
                )
            await asyncio.sleep(2)
            continue
        if permission_approval_probe:
            check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
            if (
                result_path.exists()
                and state.get("blocked", []) == []
                and "runtime-error:blocked-visible" in check_names
                and "runtime-error:linear-human-approved-resume" in check_names
            ):
                break
        if (
            result_path.exists()
            and final_issue["state"]["type"] in {"completed", "canceled"}
            and state.get("sessions") == []
            and state.get("retry_attempts") == []
            and state.get("continuations", []) == []
            and state.get("blocked", []) == []
            and run_statuses
            and all(status != "running" for status in run_statuses)
            and process_status in {"exited", "stopped"}
        ):
            break
        await asyncio.sleep(5)
    final_issue = final_issue or await fetch_linear_issue(token, issue_id)
    return write_wait_artifacts(
        evidence=evidence,
        samples=samples,
        result_path=result_path,
        final_issue=final_issue,
        state_path=state_path,
        last_state=last_state,
        ops_path=ops_path,
        last_ops=last_ops,
        log_path=log_path,
        stages=stages,
        stage_timeout_seconds=stage_timeout_seconds,
    )


async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY", "").strip()
    if not token:
        raise RuntimeError("LINEAR_API_KEY is required")
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)
    evidence = Evidence(root / "real-symphony-e2e-report.json")
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(Path.cwd() / "packages" / "performer-api" / "src"),
            str(Path.cwd() / "packages" / "performer" / "src"),
            str(Path.cwd() / "packages" / "conductor" / "src"),
            str(Path.cwd() / "packages" / "podium" / "src"),
            env.get("PYTHONPATH", ""),
        ]
    )
    bin_dir = Path.cwd() / ".venv" / "bin"
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    run_id = f"symphony-e2e-matrix-{run_id}"
    workspace_id = f"real-workspace-{run_id}"
    webhook_secret = f"webhook-{uuid.uuid4().hex}"
    evidence.data["run_id"] = run_id
    evidence.write()

    for name, command in {
        "podium-help": [str(bin_dir / "podium"), "--help"],
        "conductor-help": [str(bin_dir / "conductor"), "--help"],
        "performer-help": [str(bin_dir / "performer"), "--help"],
    }.items():
        run_cmd(name, command, evidence, env=env)

    fixture = make_fixture_repo(root / "fixture-repo")

    podium_port = allocate_port()
    conductor_port = allocate_port()
    data_root = root / "conductor-data"
    podium_env = dict(env)
    podium_env["LINEAR_WEBHOOK_SECRET"] = webhook_secret
    podium_env["PODIUM_LINEAR_ACCESS_TOKEN"] = token
    processes: list[ManagedProcess] = []
    try:
        podium = start_process(
            "podium",
            [
                str(bin_dir / "podium"),
                "api",
                "--host",
                "127.0.0.1",
                "--port",
                str(podium_port),
            ],
            env=podium_env,
            stdout_path=root / "podium.log",
        )
        processes.append(podium)
        status, body = await wait_for_http_ready(api_url(podium_port, "/"))
        evidence.check("podium-api:/", status == 200, status=status, body=body)
        for path in ["/api/v1/health"]:
            status, body = http_json("GET", api_url(podium_port, path))
            evidence.check(f"podium-api:{path}", status == 200, status=status, body=body)

        viewer = await fetch_linear_viewer(token)
        agent_app_user_id = os.environ.get("LINEAR_AGENT_APP_USER_ID", "").strip()
        if not agent_app_user_id and not args.simulate_agent_webhook:
            raise RuntimeError(
                "LINEAR_AGENT_APP_USER_ID is required for real custom-agent delegation. "
                "Set it to the Linear app user's id."
            )
        agent_app_user_id = agent_app_user_id or "real-e2e-agent-app-user"
        evidence.data["linear_agent_app_user_id"] = agent_app_user_id
        evidence.check(
            "linear-agent:app-user-selected",
            bool(agent_app_user_id),
            source="LINEAR_AGENT_APP_USER_ID" if os.environ.get("LINEAR_AGENT_APP_USER_ID", "").strip() else "simulated-default",
            viewer={key: viewer.get(key) for key in ["id", "name", "email"]},
        )
        status, enrollment_body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/enrollment-tokens"),
            {
                "runtime_group_id": f"group-{run_id}",
                "linear_workspace_id": workspace_id,
                "project_slug": args.project_slug,
                "linear_agent_app_user_id": agent_app_user_id,
                "workflow_profile": "gated-task" if args.acceptance_gates else "task",
            },
        )
        evidence.check("podium-api:/api/v1/runtime/enrollment-tokens", status == 200, status=status, body=enrollment_body)
        status, enrolled_runtime = http_json(
            "POST",
            api_url(podium_port, "/api/v1/runtime/enroll"),
            {"enrollment_token": enrollment_body.get("enrollment_token") if isinstance(enrollment_body, dict) else ""},
        )
        evidence.check(
            "podium-api:/api/v1/runtime/enroll",
            status == 200
            and bool(enrolled_runtime.get("runtime_id"))
            and bool(enrolled_runtime.get("runtime_token"))
            and bool(enrolled_runtime.get("proxy_token")),
            status=status,
            body={key: bool(enrolled_runtime.get(key)) for key in ["runtime_id", "runtime_token", "proxy_token"]},
        )

        conductor = start_process(
            "conductor",
            [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
            env=env,
            stdout_path=root / "conductor.log",
        )
        processes.append(conductor)
        status, body = await wait_for_http_ready(api_url(conductor_port, "/"))
        evidence.check("conductor-api:/", status == 200, status=status, body=body)
        status, body = http_json(
            "PATCH",
            api_url(conductor_port, "/api/settings"),
            {
                "podium_url": f"http://127.0.0.1:{podium_port}",
                "podium_runtime_id": enrolled_runtime["runtime_id"],
                "podium_runtime_token": enrolled_runtime["runtime_token"],
                "podium_proxy_token": enrolled_runtime["proxy_token"],
                "podium_ws_url": enrolled_runtime["websocket_url"],
                "runtime_group_id": enrolled_runtime["runtime_group_id"],
                "managed_mode": True,
            },
        )
        evidence.check(
            "conductor-api:/api/settings PATCH",
            status == 200
            and body["settings"]["linear_application_connected"]
            and body["settings"]["podium_runtime_token_configured"]
            and body["settings"]["podium_proxy_token_configured"]
            and body["settings"]["managed_mode"],
            status=status,
            body=body["settings"],
        )
        for method, path, payload in [
            ("GET", "/api/settings", None),
            ("GET", "/api/dashboard", None),
            ("GET", "/api/instances", None),
            ("GET", "/api/templates/workflow-profiles", None),
            ("POST", "/api/repo/inspect", {"repo_source_type": "local_path", "repo_source_value": str(fixture)}),
            ("POST", "/api/repo/clone", {"repo_url": "https://example.invalid/repo.git", "target_path": str(root / "non-empty-clone")}),
        ]:
            if path == "/api/repo/clone":
                (root / "non-empty-clone").mkdir(exist_ok=True)
                (root / "non-empty-clone" / "keep.txt").write_text("keep\n", encoding="utf-8")
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status in {200, 201}, status=status, body=body)

        linear = await create_linear_issue(token, args.project_slug, run_id)
        if not args.simulate_agent_webhook:
            linear["issue"] = await delegate_linear_issue(token, linear["issue"]["id"], agent_app_user_id)
            linear["issue"] = await fetch_linear_issue(token, linear["issue"]["id"])
        issue_path = root / "business-issue.json"
        issue_path.write_text(json.dumps(linear, indent=2, sort_keys=True), encoding="utf-8")
        evidence.artifact("business_issue", issue_path)
        evidence.check(
            "linear-agent:issue-left-human-assignee-unchanged",
            ((linear["issue"].get("assignee") or {}).get("id")) != agent_app_user_id,
            expected_agent_app_user_id=agent_app_user_id,
            actual_assignee=linear["issue"].get("assignee"),
        )
        evidence.check(
            "linear-agent:issue-delegated-to-custom-agent",
            args.simulate_agent_webhook or ((linear["issue"].get("delegate") or {}).get("id") == agent_app_user_id),
            expected_agent_app_user_id=agent_app_user_id,
            actual_delegate=linear["issue"].get("delegate"),
            simulated=args.simulate_agent_webhook,
        )
        payload = {
            "name": f"Matrix {run_id}",
            "repo_source_type": "local_path",
            "repo_source_value": str(fixture),
            "linear_project": linear["project"]["slugId"],
            "linear_filters": {"linear_agent_app_user_id": agent_app_user_id, "active_states": ["Todo", "In Progress"]},
            "workflow_profile": "gated-task" if args.acceptance_gates else "task",
            "workflow_inputs": {"goal": "Run the real Symphony e2e matrix task."},
        }
        status, body = http_json("POST", api_url(conductor_port, "/api/instances/preview-workflow"), payload)
        evidence.check("conductor-api:POST /api/instances/preview-workflow", status == 200, status=status)
        status, body = http_json("POST", api_url(conductor_port, "/api/instances"), payload)
        evidence.check("conductor-api:POST /api/instances", status == 201, status=status)
        instance = body["instance"]
        instance_id = instance["id"]
        for method, path, payload in [
            ("GET", f"/api/instances/{instance_id}", None),
            ("POST", f"/api/instances/{instance_id}/generate-workflow", {}),
            ("GET", f"/api/instances/{instance_id}/runtime", None),
            ("GET", f"/api/instances/{instance_id}/logs", None),
            ("GET", f"/api/instances/{instance_id}/logs?tail=5&order=desc", None),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        workflow = patch_workflow(
            Path(instance["workflow_path"]),
            acceptance_gates=args.acceptance_gates,
            permission_approval_probe=args.permission_approval_probe,
        )
        if args.acceptance_gates:
            workflow = patch_e2e_gate_mode(workflow, gate_mode=args.e2e_gate_mode)
        status, body = http_json("POST", api_url(conductor_port, f"/api/instances/{instance_id}/validate-workflow"), {"workflow_content": workflow})
        evidence.check(f"conductor-api:POST /api/instances/{instance_id}/validate-workflow patched", status == 200, status=status)
        status, body = http_json("PATCH", api_url(conductor_port, f"/api/instances/{instance_id}"), {"workflow_content": workflow})
        evidence.check("conductor-api:PATCH /api/instances/{id}", status == 200, status=status)
        instance = body["instance"]
        instance_path = root / "instance.json"
        instance_path.write_text(json.dumps(instance, indent=2, sort_keys=True), encoding="utf-8")
        evidence.artifact("instance", instance_path)

        # Conductor daemon restart recovery while stopped: metadata must survive.
        conductor.stop()
        processes.remove(conductor)
        conductor = start_process(
            "conductor",
            [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
            env=env,
            stdout_path=root / "conductor-restarted.log",
        )
        processes.append(conductor)
        await wait_for_http_ready(api_url(conductor_port, "/"))
        status, body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"))
        evidence.check("conductor-daemon:restart-recovers-instance-metadata", status == 200 and body["instance"]["id"] == instance_id, status=status, process_status=body.get("instance", {}).get("process_status"))

        linear_agent_sessions = ((linear["issue"].get("agentSessions") or {}).get("nodes") or [])
        linear_agent_session = linear_agent_sessions[0] if linear_agent_sessions else {}
        webhook_payload = {
            "type": "AgentSessionEvent",
            "action": "created",
            "workspace": {"id": workspace_id},
            "agentSession": {
                "id": linear_agent_session.get("id") or f"session-{uuid.uuid4().hex}",
                "appUserId": agent_app_user_id,
                "appUser": {"id": agent_app_user_id},
                "issue": {
                    "id": linear["issue"]["id"],
                    "identifier": linear["issue"]["identifier"],
                    "project": {"slugId": linear["project"]["slugId"]},
                    "assignee": linear["issue"].get("assignee"),
                    "delegate": linear["issue"].get("delegate"),
                },
            },
        }
        raw_webhook = json.dumps(webhook_payload).encode()
        status, body = http_json(
            "POST",
            api_url(podium_port, "/api/v1/linear/webhooks/agent-session"),
            raw_webhook,
            headers={"Linear-Signature": linear_webhook_signature(webhook_secret, raw_webhook)},
        )
        evidence.check(
            "podium-api:/api/v1/linear/webhooks/agent-session queues-dispatch",
            status == 200 and body.get("queued") == 1,
            status=status,
            body=body,
        )
        dispatch_instance_status = 0
        dispatch_instance_body: dict[str, Any] = {}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            dispatch_instance_status, dispatch_instance_body = http_json(
                "GET", api_url(conductor_port, f"/api/instances/{instance_id}")
            )
            process_status = dispatch_instance_body.get("instance", {}).get("process_status")
            if dispatch_instance_status == 200 and process_status in {"running", "exited"}:
                break
            await asyncio.sleep(0.5)
        evidence.check(
            "conductor-dispatch:agent-session-starts-one-shot",
            dispatch_instance_status == 200
            and dispatch_instance_body.get("instance", {}).get("process_status") in {"running", "exited"},
            status=dispatch_instance_status,
            process_status=dispatch_instance_body.get("instance", {}).get("process_status")
            if isinstance(dispatch_instance_body, dict)
            else None,
        )
        instance = dispatch_instance_body["instance"]

        run_result = await wait_for_run(
            token=token,
            issue_id=linear["issue"]["id"],
            instance=instance,
            conductor_port=conductor_port,
            evidence=evidence,
            timeout_seconds=args.timeout,
            stage_timeout_seconds=args.stage_timeout,
            permission_approval_probe=args.permission_approval_probe,
        )
        if args.permission_approval_probe:
            check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
            evidence.check(
                "runtime-error:permission-approval-covered",
                "runtime-error:blocked-visible" in check_names
                and "runtime-error:linear-human-approved-resume" in check_names,
                covered=sorted(name for name in check_names if str(name).startswith("runtime-error:")),
            )
        issue = run_result["issue"]
        ops = run_result["ops"]
        state = run_result["state"]
        result_path = Path(run_result["result_path"])
        run_statuses = [run.get("status") for run in ops.get("runs", {}).values()]
        if args.permission_approval_probe:
            evidence.check("real-flow:workspace-result", result_path.exists(), path=str(result_path))
            evidence.check("runtime-error:blocked-cleared-after-approval", not state.get("blocked"), state=state)
        else:
            evidence.check(
                "real-flow:linear-done",
                issue["state"]["type"] in {"completed", "canceled"},
                identifier=issue["identifier"],
                state=issue["state"],
            )
            evidence.check(
                "real-flow:linear-agent-app-user-dispatched",
                args.simulate_agent_webhook or ((issue.get("delegate") or {}).get("id") == agent_app_user_id),
                expected_agent_app_user_id=agent_app_user_id,
                actual_delegate=issue.get("delegate"),
                actual_assignee=issue.get("assignee"),
                simulated=args.simulate_agent_webhook,
            )
            evidence.check("real-flow:workspace-result", result_path.exists(), path=str(result_path))
            evidence.check(
                "real-flow:no-active-runtime-state",
                not state.get("sessions")
                and not state.get("retry_attempts")
                and not state.get("continuations")
                and not state.get("blocked"),
                state=state,
            )
            evidence.check("real-flow:ops-finalized", bool(run_statuses) and all(status != "running" for status in run_statuses), run_statuses=run_statuses)
        if args.acceptance_gates:
            tree = await fetch_linear_issue_tree(token, linear["issue"]["id"])
            tree_path = root / "final-issue-tree.json"
            tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
            evidence.artifact("final_issue_tree", tree_path)
            issue_labels = [label["name"] for label in tree["labels"]["nodes"]]
            children = tree["children"]["nodes"]
            gates = [
                child
                for child in children
                if any(label["name"] == "performer:type/gate" for label in child["labels"]["nodes"])
            ]
            evidence_issues = [
                grandchild
                for gate in gates
                for grandchild in gate["children"]["nodes"]
                if any(label["name"] == "performer:type/evidence" for label in grandchild["labels"]["nodes"])
            ]
            evidence.check(
                "stage:gate_created",
                bool(gates),
                gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
            )
            evidence.check(
                "stage:evidence_created",
                bool(evidence_issues),
                evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
            )
            evidence.check(
                "stage:final_done",
                tree["state"]["type"] in {"completed", "canceled"}
                and all(gate["state"]["type"] in {"completed", "canceled"} for gate in gates)
                and all(item["state"]["type"] in {"completed", "canceled"} for item in evidence_issues),
                issue_state=tree["state"],
                gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
                evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
            )
            gate_failed = any(
                any(label["name"] == "performer:gate/failed" for label in node["labels"]["nodes"])
                for node in [tree, *gates]
            )
            gate_comments = "\n".join(
                comment["body"]
                for gate in gates
                for comment in gate["comments"]["nodes"]
            )
            evidence.check(
                "acceptance:gate-child-created",
                bool(gates),
                gates=[{"identifier": gate["identifier"], "state": gate["state"]} for gate in gates],
            )
            evidence.check(
                "acceptance:evidence-child-created",
                bool(evidence_issues),
                evidence=[{"identifier": item["identifier"], "state": item["state"]} for item in evidence_issues],
            )
            evidence.check(
                "acceptance:gate-passed-visible",
                "performer:gate/passed" in issue_labels and not gate_failed and "Acceptance score:" in gate_comments,
                labels=issue_labels,
                gate_failed=gate_failed,
            )
            delegated_acceptance_issues = [*gates, *evidence_issues]
            evidence.check(
                "acceptance:all-gate-and-evidence-issues-delegated",
                bool(delegated_acceptance_issues)
                and all((item.get("delegate") or {}).get("id") == agent_app_user_id for item in delegated_acceptance_issues),
                expected_agent_app_user_id=agent_app_user_id,
                issues=[
                    {
                        "identifier": item["identifier"],
                        "delegate": item.get("delegate"),
                    }
                    for item in delegated_acceptance_issues
                ],
            )

        for method, path, payload in [
            ("GET", "/api/issues", None),
            ("GET", "/api/runs", None),
            ("GET", "/api/traces", None),
            ("GET", "/api/retention", None),
            ("POST", "/api/retention/collect", {}),
        ]:
            status, body = http_json(method, api_url(conductor_port, path), payload)
            evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        if ops.get("issues"):
            ops_issue_id = next(iter(ops["issues"].keys()))
            for method, path in [
                ("GET", f"/api/issues/{ops_issue_id}"),
                ("POST", f"/api/issues/{ops_issue_id}/pin"),
                ("DELETE", f"/api/issues/{ops_issue_id}/pin"),
            ]:
                status, body = http_json(method, api_url(conductor_port, path), {} if method == "POST" else None)
                evidence.check(f"conductor-api:{method} {path}", status == 200, status=status)
        if ops.get("runs"):
            ops_run_id = next(iter(ops["runs"].keys()))
            status, body = http_json("GET", api_url(conductor_port, f"/api/runs/{ops_run_id}"))
            evidence.check("conductor-api:GET /api/runs/{id}", status == 200, status=status)

        conductor.stop()
        processes.remove(conductor)
        conductor = start_process(
            "conductor",
            [str(bin_dir / "conductor"), "--port", str(conductor_port), "--data-root", str(data_root)],
            env=env,
            stdout_path=root / "conductor-live-recovered.log",
        )
        processes.append(conductor)
        await wait_for_http_ready(api_url(conductor_port, "/"))
        status, body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"))
        recovered = body.get("instance", {}) if isinstance(body, dict) else {}
        evidence.check(
            "conductor-daemon:restart-recovers-completed-one-shot",
            status == 200 and recovered.get("process_status") in {"exited", "stopped"},
            status=status,
            process_status=recovered.get("process_status"),
            pid=recovered.get("pid"),
        )
        status, body = http_json("POST", api_url(conductor_port, f"/api/instances/{instance_id}/stop"), {})
        evidence.check("conductor-api:POST /api/instances/{id}/stop", status == 200, status=status)

        disposable_fixture = make_fixture_repo(root / "fixture-repo-disposable")
        disposable_payload = {
            "name": f"Disposable {run_id}",
            "repo_source_type": "local_path",
            "repo_source_value": str(disposable_fixture),
            "linear_project": linear["project"]["slugId"],
            "linear_filters": {"linear_agent_app_user_id": agent_app_user_id, "active_states": ["Todo"]},
            "workflow_profile": "task",
            "workflow_inputs": {},
        }
        status, body = http_json("POST", api_url(conductor_port, "/api/instances"), disposable_payload)
        disposable_id = body.get("instance", {}).get("id") if status == 201 else None
        evidence.check("conductor-api:POST /api/instances disposable", status == 201, status=status)
        if disposable_id:
            status, body = http_json("DELETE", api_url(conductor_port, f"/api/instances/{disposable_id}"))
            evidence.check("conductor-api:DELETE /api/instances/{id}", status == 200, status=status)
    finally:
        for process in reversed(processes):
            process.stop()
    evidence.data["completed_at"] = utc_now()
    evidence.write()
    return evidence.data


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Symphony Podium/Conductor/Performer e2e matrix.")
    arg_parser.add_argument("--out", type=Path, default=Path(".test-real-flow/e2e-matrix"))
    arg_parser.add_argument("--project-slug", default=DEFAULT_PROJECT_SLUG)
    arg_parser.add_argument("--acceptance-gates", action=argparse.BooleanOptionalAction, default=True)
    arg_parser.add_argument("--e2e-gate-mode", choices=["smoke", "strict"], default="smoke")
    arg_parser.add_argument("--stage-timeout", type=int, default=120)
    arg_parser.add_argument("--permission-approval-probe", action="store_true")
    arg_parser.add_argument(
        "--simulate-agent-webhook",
        action="store_true",
        help="Use a synthetic AgentSessionEvent instead of requiring the Linear issue to be delegated to the app user.",
    )
    arg_parser.add_argument("--timeout", type=int, default=420)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    try:
        report = asyncio.run(run(args))
    except Exception as exc:
        print(f"real_symphony_e2e failed: {exc!r}", file=sys.stderr)
        return 1
    print(json.dumps({"report": str(args.out / "real-symphony-e2e-report.json"), "failures": len(report["failures"])}, indent=2))
    return 0 if not report["failures"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
