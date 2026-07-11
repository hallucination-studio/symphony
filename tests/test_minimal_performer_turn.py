from __future__ import annotations

import json
from pathlib import Path

import pytest

from performer.cli import run_turn


async def run_request(tmp_path: Path, request: dict[str, object], client: FakeCodexClient) -> dict[str, object]:
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(json.dumps({"workspace_path": str(tmp_path), **request}), encoding="utf-8")

    body = await run_turn(request_path, result_path, codex_client=client)

    assert json.loads(result_path.read_text(encoding="utf-8")) == body
    return body


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
            "issue_description": "Implement the feature",
        },
        client,
    )

    assert body["turn_kind"] == "plan"
    assert body["plan"]["tasks"][0]["id"] == "task-1"
    assert client.calls[0]["output_schema"]["required"] == ["summary", "tasks"]


@pytest.mark.asyncio
async def test_execute_turn_uses_the_fenced_task(tmp_path: Path, task_payload, fake_codex_client) -> None:
    client = fake_codex_client(
        {
            "status": "ready_for_gate",
            "summary": "Implemented",
            "changed_files": ["src/api.py"],
            "acceptance_evidence": [{"criterion": "The endpoint returns 200", "evidence": "pytest passed"}],
            "blocked_reason": None,
        }
    )

    body = await run_request(
        tmp_path,
        {
            "context": {"run_id": "run-1", "task_id": "task-1", "attempt_id": "attempt-1", "fencing_token": 2, "turn_kind": "execute"},
            "task": task_payload,
        },
        client,
    )

    assert body["result"]["status"] == "ready_for_gate"
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
            "task": task_payload,
            "evidence": {"commands": [{"command": "pytest -q", "passed": True}]},
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
            "task": task_payload,
        },
        client,
    )

    assert body["runtime_wait"] == {"kind": "permission_required", "reason": "Need workspace permission."}
    assert "result" not in body
