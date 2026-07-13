from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from performer.cli import run_turn
from performer.backend_interface import PerformerBackendError
from performer.backend_registry import BackendRegistry
from performer.backends.codex import CodexBackend
from performer_api.runtime_policy import canonical_sha256


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


async def run_request(tmp_path: Path, request: dict[str, object], client: FakeCodexClient) -> dict[str, object]:
    if not (tmp_path / ".git").exists():
        subprocess.run(
            ["git", "init", "-q", str(tmp_path)],
            check=True,
            capture_output=True,
        )
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    context = request["context"]
    policy = request["execution_policy"]
    strict_request = {
        "protocol_version": 1,
        "context": context,
        "performer_kind": "codex",
        "performer_binding_id": "binding-1",
        "binding_generation": 1,
        "execution_policy": policy,
        "execution_policy_sha256": canonical_sha256(policy),
        "turn_policy_sha256": "a" * 64,
        "workspace_path": str(tmp_path),
        "thread_id": "",
        "issue_description": request.get("issue_description", ""),
        "task": request.get("task"),
        "evidence": request.get("evidence"),
    }
    request_path.write_text(json.dumps(strict_request), encoding="utf-8")

    body = await run_turn(request_path, result_path, registry=_registry(client))

    assert json.loads(result_path.read_text(encoding="utf-8")) == body
    return body


def _registry(client: FakeCodexClient) -> BackendRegistry:
    return BackendRegistry({"codex": lambda: CodexBackend(client_factory=lambda _config: client)})


@pytest.mark.asyncio
async def test_plan_turn_writes_validated_plan(tmp_path: Path, task_payload, fake_codex_client) -> None:
    client = fake_codex_client(
        {
            "summary": "Implement the feature",
            "tasks": [task_payload],
        }
    )

    body = await run_request(
        tmp_path,
        {
            "context": {"run_id": "run-1", "task_id": "", "attempt_id": "attempt-1", "fencing_token": 1, "turn_kind": "plan"},
            "execution_policy": EXECUTION_POLICY,
            "issue_description": "Implement the feature",
        },
        client,
    )

    assert body["context"]["turn_kind"] == "plan"
    assert body["plan"]["tasks"][0]["id"] == "task-1"
    assert set(client.calls[0]["output_schema"]["required"]) == {
        "summary",
        "tasks",
        "risks",
        "architecture_decisions",
        "open_questions",
        "approval_required",
    }


@pytest.mark.asyncio
async def test_execute_turn_uses_the_fenced_task(tmp_path: Path, task_payload, fake_codex_client) -> None:
    client = fake_codex_client(
        {
            "status": "ready_for_gate",
            "summary": "Implemented",
            "changed_files": ["src/api.py"],
            "acceptance_evidence": [
                {
                    "criterion": "The endpoint returns 200",
                    "evidence": "pytest passed",
                    "passed": True,
                }
            ],
            "blocked_reason": None,
        }
    )

    body = await run_request(
        tmp_path,
        {
            "context": {"run_id": "run-1", "task_id": "task-1", "attempt_id": "attempt-1", "fencing_token": 2, "turn_kind": "execute"},
            "execution_policy": EXECUTION_POLICY,
            "task": task_payload,
        },
        client,
    )

    assert body["execute_result"]["status"] == "ready_for_gate"
    assert "Execute task task-1 only" in client.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_gate_turn_is_read_only_and_keeps_rubric_evidence(tmp_path: Path, task_payload, fake_codex_client) -> None:
    client = fake_codex_client(
        {
            "passed": True,
            "score": 4,
            "threshold": 3,
            "rubric": {"correctness": {"score": 4, "weight": 2}},
            "provenance": [{"source": "codex", "attempt_id": "attempt-1"}],
            "findings": ["All commands passed"],
            "artifact_refs": ["artifact://run-1/task-1"],
        }
    )

    body = await run_request(
        tmp_path,
        {
            "context": {"run_id": "run-1", "task_id": "task-1", "attempt_id": "attempt-1", "fencing_token": 3, "turn_kind": "gate"},
            "execution_policy": EXECUTION_POLICY,
            "task": task_payload,
            "evidence": {"commands": [{"command": "pytest -q", "passed": True, "exit_code": 0, "output": "ok"}]},
        },
        client,
    )

    assert body["gate_result"]["passed"] is True
    assert body["gate_result"]["rubric"]["correctness"]["weight"] == 2
    assert "Do not change files" in client.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_execute_turn_surfaces_actual_codex_runtime_wait(tmp_path: Path, task_payload, fake_codex_client) -> None:
    client = fake_codex_client(
        {},
        events=[
            {
                "event": "sdk_item_autoApprovalReview_started",
                "payload": {
                    "type": "item/autoApprovalReview/started",
                    "reviewId": "review-1",
                    "action": {"type": "requestPermissions", "reason": "Need workspace permission."},
                },
            }
        ],
    )

    body = await run_request(
        tmp_path,
        {
            "context": {"run_id": "run-1", "task_id": "task-1", "attempt_id": "attempt-1", "fencing_token": 4, "turn_kind": "execute"},
            "execution_policy": EXECUTION_POLICY,
            "task": task_payload,
        },
        client,
    )

    assert body["runtime_wait"] == {"kind": "permission_required", "reason": "Need workspace permission."}
    assert body["execute_result"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "execution_policy",
    [
        None,
        {**EXECUTION_POLICY, "sandbox": {**EXECUTION_POLICY["sandbox"], "plan": "workspace_write"}},
    ],
)
async def test_turn_rejects_missing_or_invalid_execution_policy_before_backend_invocation(
    tmp_path: Path,
    fake_codex_client,
    execution_policy: object,
) -> None:
    client = fake_codex_client({"summary": "must not run", "tasks": []})
    request = {
        "protocol_version": 1,
        "context": {
            "run_id": "run-1",
            "task_id": "",
            "attempt_id": "attempt-1",
            "fencing_token": 5,
            "turn_kind": "plan",
        },
        "performer_kind": "codex",
        "performer_binding_id": "binding-1",
        "binding_generation": 1,
        "issue_description": "Implement the feature",
        "thread_id": "",
        "task": None,
        "evidence": None,
        "turn_policy_sha256": "a" * 64,
    }
    if execution_policy is not None:
        request["execution_policy"] = execution_policy
        request["execution_policy_sha256"] = canonical_sha256(execution_policy)
    else:
        request["execution_policy"] = None
        request["execution_policy_sha256"] = "0" * 64

    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request["workspace_path"] = str(tmp_path)
    request_path.write_text(json.dumps(request), encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        await run_turn(request_path, result_path, registry=_registry(client))

    assert getattr(exc_info.value, "code", "") == "invalid_runtime_policy"
    assert client.calls == []
    assert not result_path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("turn_kind", ["plan", "gate"])
@pytest.mark.parametrize(
    "git_failure",
    ["unavailable", "timeout", "rev_parse_command", "snapshot_command"],
)
async def test_read_only_turn_fails_closed_when_git_snapshot_cannot_be_verified(
    tmp_path: Path,
    task_payload,
    fake_codex_client,
    monkeypatch,
    turn_kind: str,
    git_failure: str,
) -> None:
    structured_result = (
        {"summary": "Implement the feature", "tasks": [task_payload]}
        if turn_kind == "plan"
        else {
            "passed": True,
            "score": 4,
            "threshold": 3,
            "rubric": {"correctness": {"score": 4, "weight": 2}},
            "provenance": [{"source": "codex"}],
            "findings": [],
            "artifact_refs": [],
        }
    )
    client = fake_codex_client(structured_result)
    subprocess.run(
        ["git", "init", "-q", str(tmp_path)],
        check=True,
        capture_output=True,
    )

    def fail_git(command, **_kwargs):
        if git_failure == "unavailable":
            raise FileNotFoundError("git")
        if git_failure == "timeout":
            raise subprocess.TimeoutExpired(command, 5)
        if (
            command[-2:] == ["rev-parse", "--is-inside-work-tree"]
            and git_failure != "rev_parse_command"
        ):
            return subprocess.CompletedProcess(command, 0, stdout=b"true\n", stderr=b"")
        return subprocess.CompletedProcess(command, 1, stdout=b"", stderr=b"snapshot failed")

    monkeypatch.setattr("performer.managed_turn.subprocess.run", fail_git)

    with pytest.raises(PerformerBackendError) as exc_info:
        await run_request(
            tmp_path,
            {
                "context": {
                    "run_id": "run-1",
                    "task_id": "" if turn_kind == "plan" else "task-1",
                    "attempt_id": "attempt-1",
                    "fencing_token": 6,
                    "turn_kind": turn_kind,
                },
                "execution_policy": EXECUTION_POLICY,
                "issue_description": "Implement the feature" if turn_kind == "plan" else "",
                "task": None if turn_kind == "plan" else task_payload,
                "evidence": (
                    None
                    if turn_kind == "plan"
                    else {
                        "commands": [
                            {
                                "command": "pytest -q",
                                "passed": True,
                                "exit_code": 0,
                                "output": "ok",
                            }
                        ]
                    }
                ),
            },
            client,
        )

    assert exc_info.value.code == "workspace_snapshot_failed"
    assert client.calls == []
