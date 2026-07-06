from __future__ import annotations

import json
import os
import signal
import asyncio
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LINEAR_ENDPOINT = "https://api.linear.app/graphql"
DEFAULT_PROJECT_SLUG = "d17d2f7a038d"
SENSITIVE_EVIDENCE_KEY_PARTS = ("secret", "password", "cookie", "authorization")


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
        row = redact_evidence_value({"name": name, "passed": passed, **details})
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


def redact_evidence_value(value: Any, *, key: str | None = None) -> Any:
    if isinstance(value, dict):
        return {item_key: redact_evidence_value(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [redact_evidence_value(item) for item in value]
    if isinstance(value, str) and key is not None and _is_sensitive_evidence_key(key):
        return "<redacted>"
    return value


def _is_sensitive_evidence_key(key: str) -> bool:
    normalized = key.lower()
    return normalized.endswith("_token") or any(part in normalized for part in SENSITIVE_EVIDENCE_KEY_PARTS)


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
    except (TimeoutError, urllib.error.URLError, OSError) as exc:
        return 0, {"error": type(exc).__name__, "reason": str(exc)}


def read_json_object_if_ready(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return payload if isinstance(payload, dict) else default



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
        status, body = http_json("GET", url, timeout=2)
        if 200 <= status < 300:
            return status, body
        last_error = json.dumps(body) if isinstance(body, dict) else str(body)
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


def patch_workflow(
    workflow_path: Path,
    *,
    acceptance_gates: bool,
    permission_approval_probe: bool = False,
    sdk_codex_bin: str | None = None,
    init_max_attempts: int | None = None,
    init_backoff_ms: int | None = None,
    init_backoff_max_ms: int | None = None,
    read_timeout_ms: int | None = None,
    hard_turn_timeout_ms: int | None = None,
    overload_max_attempts: int | None = None,
    overload_initial_delay_ms: int | None = None,
    overload_max_delay_ms: int | None = None,
    config_overrides: list[str] | None = None,
) -> str:
    workflow = workflow_path.read_text(encoding="utf-8")
    codex_bin = sdk_codex_bin or shutil.which("codex")
    if codex_bin and "  sdk_codex_bin:" not in workflow:
        workflow = workflow.replace("codex:\n", f"codex:\n  sdk_codex_bin: {codex_bin}\n", 1)
    elif codex_bin:
        workflow = _replace_or_insert_codex_key(workflow, "sdk_codex_bin", codex_bin)
    if init_max_attempts is not None:
        workflow = _replace_or_insert_codex_key(workflow, "init_max_attempts", str(init_max_attempts))
    if init_backoff_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "init_backoff_ms", str(init_backoff_ms))
    if init_backoff_max_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "init_backoff_max_ms", str(init_backoff_max_ms))
    if read_timeout_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "read_timeout_ms", str(read_timeout_ms))
    if hard_turn_timeout_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "hard_turn_timeout_ms", str(hard_turn_timeout_ms))
    if overload_max_attempts is not None:
        workflow = _replace_or_insert_codex_key(workflow, "overload_max_attempts", str(overload_max_attempts))
    if overload_initial_delay_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "overload_initial_delay_ms", str(overload_initial_delay_ms))
    if overload_max_delay_ms is not None:
        workflow = _replace_or_insert_codex_key(workflow, "overload_max_delay_ms", str(overload_max_delay_ms))
    if config_overrides:
        workflow = _replace_or_insert_codex_list(workflow, "config_overrides", config_overrides)
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


def _replace_or_insert_codex_key(workflow: str, key: str, value: str) -> str:
    lines = workflow.splitlines()
    output: list[str] = []
    in_codex = False
    inserted = False
    key_prefix = f"  {key}:"
    for line in lines:
        if line.startswith("codex:"):
            in_codex = True
            output.append(line)
            continue
        if in_codex and line and not line.startswith(" "):
            if not inserted:
                output.append(f"  {key}: {value}")
                inserted = True
            in_codex = False
        if in_codex and line.startswith(key_prefix):
            if not inserted:
                output.append(f"  {key}: {value}")
                inserted = True
            continue
        output.append(line)
    if in_codex and not inserted:
        output.append(f"  {key}: {value}")
    return "\n".join(output) + ("\n" if workflow.endswith("\n") else "")


def _replace_or_insert_codex_list(workflow: str, key: str, values: list[str]) -> str:
    lines = workflow.splitlines()
    output: list[str] = []
    in_codex = False
    skipping_existing = False
    inserted = False
    key_prefix = f"  {key}:"
    rendered = [f"  {key}:", *[f"    - {value}" for value in values]]
    for line in lines:
        if line.startswith("codex:"):
            in_codex = True
            output.append(line)
            continue
        if skipping_existing:
            if line.startswith("    - "):
                continue
            skipping_existing = False
        if in_codex and line and not line.startswith(" "):
            if not inserted:
                output.extend(rendered)
                inserted = True
            in_codex = False
        if in_codex and line.startswith(key_prefix):
            if not inserted:
                output.extend(rendered)
                inserted = True
            skipping_existing = True
            continue
        output.append(line)
    if in_codex and not inserted:
        output.extend(rendered)
    return "\n".join(output) + ("\n" if workflow.endswith("\n") else "")


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
