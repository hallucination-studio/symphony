from __future__ import annotations

import json
from pathlib import Path

from performer.workspace_execution_state import WorkspaceExecutionState


class Result:
    thread_id = "thread-1"
    turn_id = "turn-1"
    final_response = "Phase summary"


def test_workspace_execution_state_reads_and_writes_thread_id(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    state = WorkspaceExecutionState(workspace)

    state.write_sdk_thread(issue_id="issue-1", result=Result())

    execution_file = workspace / ".symphony" / "execution.json"
    payload = json.loads(execution_file.read_text(encoding="utf-8"))
    assert state.sdk_thread_id(issue_id="issue-1") == "thread-1"
    assert payload["thread_id"] == "thread-1"
    assert payload["prior_phase_summary"] == "Phase summary"
    assert payload["status"] == "resume_pending"


def test_workspace_execution_state_failed_thread_is_not_resumable(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    state = WorkspaceExecutionState(workspace)

    state.write_sdk_thread_failure(
        issue_id="issue-1",
        thread_id="thread-1",
        turn_id="turn-2",
        error="codex failed",
    )

    execution_file = workspace / ".symphony" / "execution.json"
    payload = json.loads(execution_file.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["failure_summary"] == "codex failed"
    assert state.sdk_thread_id(issue_id="issue-1") is None


def test_workspace_execution_state_rejects_other_issue_or_backend(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    execution_dir = workspace / ".symphony"
    execution_dir.mkdir(parents=True)
    (execution_dir / "execution.json").write_text(
        json.dumps({"issue_id": "other", "thread_id": "thread-1", "backend": "sdk", "status": "resume_pending"}),
        encoding="utf-8",
    )

    assert WorkspaceExecutionState(workspace).sdk_thread_id(issue_id="issue-1") is None
