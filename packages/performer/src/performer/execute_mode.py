from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
from typing import Any

from performer_api.pipeline import HumanEscalationReason, RuntimeMode

from .mode_common import (
    _attempt_event_printer,
    _emit_runtime_wait_probe_if_requested,
    _fencing_fields,
    _file_sha256,
    _git,
    _managed_codex_backend,
    _optional_payload_str,
    _payload_kind,
    _sanitize_error,
    _thread_state_workspace_path,
)
from .workspace_execution_state import WorkspaceExecutionState


async def _run_execute_mode(payload: dict[str, object], *, agent_backend: Any | None = None) -> dict[str, object]:
    attempt_id = str(payload.get("attempt_id") or "execute-attempt")
    node_id = str(payload.get("node_id") or payload.get("task_id") or "")
    gate_hash = str(payload.get("gate_snapshot_hash") or "")
    workspace_path = _execute_workspace_path(payload)
    source_repository_path = _execute_repository_path(payload)
    verification_input: dict[str, object]
    result: object | None = None
    if workspace_path:
        workspace = Path(workspace_path)
        if source_repository_path and Path(source_repository_path) != workspace:
            _materialize_execute_workspace(
                source_repository_path=Path(source_repository_path),
                workspace_path=workspace,
                base_revision=str(payload.get("base_revision") or ""),
            )
        result, failure = await _invoke_execute_backend(
            payload,
            workspace,
            agent_backend,
            attempt_id=attempt_id,
            node_id=node_id,
            gate_hash=gate_hash,
        )
        if failure is not None:
            return failure
        verification_input = _collect_git_verification_input(
            workspace_path=workspace,
            attempt_id=attempt_id,
            node_id=node_id,
            gate_hash=gate_hash,
            base_revision=str(payload.get("base_revision") or ""),
            repository_path=source_repository_path,
            requested_branch_name=_execute_branch_name(payload),
        )
    else:
        verification_input = _request_verification_input(payload, attempt_id=attempt_id, node_id=node_id, gate_hash=gate_hash)
    return {
        "attempt_id": attempt_id,
        "mode": RuntimeMode.EXECUTE.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "node_id": node_id,
        "gate_snapshot_hash": gate_hash,
        "thread_id": getattr(result, "thread_id", None),
        "kind": _payload_kind(payload, default="codex"),
        "verification_input": verification_input,
    }


async def _invoke_execute_backend(
    payload: dict[str, object],
    workspace: Path,
    agent_backend: Any | None,
    *,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
) -> tuple[object | None, dict[str, object] | None]:
    try:
        backend = agent_backend or _managed_codex_backend()
    except RuntimeError as exc:
        return None, _failed_execute_result(payload, attempt_id=attempt_id, node_id=node_id, gate_hash=gate_hash, error=str(exc))
    try:
        on_event = _attempt_event_printer(RuntimeMode.EXECUTE, attempt_id=attempt_id, node_id=node_id)
        await _emit_runtime_wait_probe_if_requested(on_event)
        execution_state = WorkspaceExecutionState(_thread_state_workspace_path(payload, fallback=workspace))
        existing_thread_id = execution_state.sdk_thread_id(issue_id=node_id)
        expected_thread_id = _optional_payload_str(payload.get("expected_thread_id"))
        if expected_thread_id and existing_thread_id != expected_thread_id:
            return None, _failed_execute_result(
                payload,
                attempt_id=attempt_id,
                node_id=node_id,
                gate_hash=gate_hash,
                error=HumanEscalationReason.THREAD_LOST.value,
                thread_id=expected_thread_id,
            )
        result = await backend.run_session(
            workspace,
            _executor_prompt(payload),
            f"Execute {node_id}",
            on_event=on_event,
            max_turns=1,
            existing_thread_id=existing_thread_id,
        )
        execution_state.write_sdk_thread(issue_id=node_id, result=result)
        return result, None
    except Exception as exc:
        return None, _failed_execute_result(payload, attempt_id=attempt_id, node_id=node_id, gate_hash=gate_hash, error=_sanitize_error(exc))


def _request_verification_input(
    payload: dict[str, object],
    *,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
) -> dict[str, object]:
    return {
        "task_id": node_id,
        "execute_attempt_id": attempt_id,
        "base_revision": str(payload.get("base_revision") or ""),
        "patch_uri": str(payload.get("patch_uri") or ""),
        "patch_hash": str(payload.get("patch_hash") or ""),
        "expected_result_tree": str(payload.get("expected_result_tree") or ""),
        "artifact_uris": list(payload.get("artifact_uris") or []),
        "declared_commands": list(payload.get("declared_commands") or []),
        "evidence_uri": str(payload.get("evidence_uri") or ""),
        "gate_snapshot_hash": gate_hash,
        "result_revision": _optional_payload_str(payload.get("result_revision")),
    }


def _failed_execute_result(
    payload: dict[str, object],
    *,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
    error: str,
    thread_id: str | None = None,
) -> dict[str, object]:
    return {
        "attempt_id": attempt_id,
        "mode": RuntimeMode.EXECUTE.value,
        "status": "failed",
        **_fencing_fields(payload),
        "node_id": node_id,
        "gate_snapshot_hash": gate_hash,
        "verification_input": {},
        "error": error,
        "thread_id": thread_id,
        "kind": _payload_kind(payload, default="codex"),
    }


def _executor_prompt(payload: dict[str, object]) -> str:
    gate_snapshot = payload.get("gate_snapshot")
    issue_identifier = str(payload.get("issue_identifier") or payload.get("node_id") or "")
    task_title = str(payload.get("task_title") or payload.get("node_id") or "")
    issue_description = str(payload.get("issue_description") or "").strip()
    return (
        "Implement exactly the requested Symphony pipeline node in this workspace. "
        "Do not mutate the frozen gate. Leave the repository with the patch that "
        "the verifier should apply against the baseline. Treat the task context and "
        "frozen gate as binding; if they name a specific file or command, do that "
        "specific work instead of broad investigation. All file writes must happen "
        "inside the current execution workspace. If a gate or issue text mentions an "
        "absolute path outside the current workspace, interpret the requested repository "
        "file relative to the current workspace root.\n\n"
        f"Task context:\nIssue: {issue_identifier}\nTitle: {task_title}\nDescription:\n{issue_description or '(none)'}\n\n"
        f"Attempt request:\n{json.dumps({**payload, 'gate_snapshot': gate_snapshot}, sort_keys=True, default=str)}"
    )

def _execute_workspace_path(payload: dict[str, object]) -> str | None:
    direct = _optional_payload_str(payload.get("workspace_path"))
    if direct:
        return direct
    artifact_paths = payload.get("artifact_paths")
    if isinstance(artifact_paths, dict):
        workspace = _optional_payload_str(artifact_paths.get("workspace_path"))
        if workspace:
            return workspace
        attempt_dir = _optional_payload_str(artifact_paths.get("attempt_dir"))
        if attempt_dir:
            return str(Path(attempt_dir) / "workspace")
    return _execute_repository_path(payload)


def _thread_state_workspace_path(payload: dict[str, object], *, fallback: Path) -> Path:
    thread_state_workspace = _optional_payload_str(payload.get("thread_state_workspace_path"))
    if thread_state_workspace:
        return Path(thread_state_workspace)
    return fallback


def _payload_kind(payload: dict[str, object], *, default: str) -> str:
    return _optional_payload_str(payload.get("kind")) or default


def _execute_repository_path(payload: dict[str, object]) -> str | None:
    repository = payload.get("repository")
    if isinstance(repository, dict):
        resolved_repo_path = _optional_payload_str(repository.get("resolved_repo_path"))
        if resolved_repo_path:
            return resolved_repo_path
    return None


def _execute_branch_name(payload: dict[str, object]) -> str | None:
    repository = payload.get("repository")
    if isinstance(repository, dict):
        return _optional_payload_str(repository.get("branch_name"))
    return None


def _materialize_execute_workspace(
    *,
    source_repository_path: Path,
    workspace_path: Path,
    base_revision: str,
) -> None:
    if workspace_path.exists():
        shutil.rmtree(workspace_path)
    workspace_path.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--quiet", str(source_repository_path), str(workspace_path)], cwd=source_repository_path)
    if base_revision:
        _git(["checkout", "--quiet", base_revision], cwd=workspace_path)

def _collect_git_verification_input(
    *,
    workspace_path: Path,
    attempt_id: str,
    node_id: str,
    gate_hash: str,
    base_revision: str,
    repository_path: str | None = None,
    requested_branch_name: str | None = None,
) -> dict[str, object]:
    _remove_generated_verification_caches(workspace_path)
    _git(["add", "--all"], cwd=workspace_path)
    no_changes = _git_command_succeeds(["diff", "--cached", "--quiet"], cwd=workspace_path)
    if not no_changes:
        _git(["commit", "--quiet", "-m", f"Execute pipeline node {node_id}"], cwd=workspace_path)
    branch_name = _git(["branch", "--show-current"], cwd=workspace_path).strip() or (requested_branch_name or "")
    commit_sha = _git(["rev-parse", "HEAD"], cwd=workspace_path).strip()
    evidence_path = workspace_path / ".symphony" / "pipeline" / attempt_id / "evidence.json"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(
        json.dumps(
            {
                "attempt_id": attempt_id,
                "node_id": node_id,
                "branch_name": branch_name,
                "commit_sha": commit_sha,
                "no_changes": no_changes,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return {
        "task_id": node_id,
        "execute_attempt_id": attempt_id,
        "base_revision": base_revision or _git(["rev-parse", "HEAD"], cwd=workspace_path).strip(),
        "repository_path": repository_path or str(workspace_path),
        "workspace_path": str(workspace_path),
        "branch_name": branch_name,
        "commit_sha": commit_sha,
        "no_changes": no_changes,
        "artifact_uris": [{"uri": f"file://{evidence_path}", "sha256": _file_sha256(evidence_path), "type": "evidence"}],
        "declared_commands": [],
        "evidence_uri": f"file://{evidence_path}",
        "gate_snapshot_hash": gate_hash,
    }


def _git_command_succeeds(args: list[str], *, cwd: Path) -> bool:
    return subprocess.run(["git", *args], cwd=cwd, check=False, capture_output=True, text=True).returncode == 0

def _remove_generated_verification_caches(workspace_path: Path) -> None:
    shutil.rmtree(workspace_path / ".pytest_cache", ignore_errors=True)
    for cache_dir in workspace_path.rglob("__pycache__"):
        if ".git" not in cache_dir.parts:
            shutil.rmtree(cache_dir, ignore_errors=True)
    for compiled in workspace_path.rglob("*.py[co]"):
        if ".git" not in compiled.parts:
            compiled.unlink(missing_ok=True)
