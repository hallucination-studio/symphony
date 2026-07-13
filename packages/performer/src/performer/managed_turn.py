"""Provider-neutral Symphony turn semantics owned by Performer core."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
import hashlib
from pathlib import Path
import stat
import subprocess
from typing import Any

from performer_api import (
    ExecuteResult,
    GateResult,
    PerformerTurnEvent,
    PerformerTurnRequest,
    PerformerTurnResult,
    Plan,
    RuntimeWait,
    validate_plan,
)
from performer_api.validation import ContractValidationError

from .schemas import EXECUTE_SCHEMA, GATE_SCHEMA, PLAN_SCHEMA


@dataclass(frozen=True)
class ProviderTurnOutput:
    thread_id: str
    structured_result: dict[str, Any]
    events: tuple[PerformerTurnEvent, ...] = ()
    runtime_wait: RuntimeWait | None = None


ProviderTurnRunner = Callable[
    [Path, str, str | None, dict[str, Any]],
    Awaitable[ProviderTurnOutput],
]


class ManagedTurnError(RuntimeError):
    def __init__(self, code: str, sanitized_reason: str | None = None) -> None:
        super().__init__(sanitized_reason or code)
        self.code = code


@dataclass(frozen=True)
class _WorkspaceSnapshot:
    is_git: bool
    files: dict[str, str]
    index_sha256: str


async def run_managed_turn(
    request: PerformerTurnRequest,
    provider_runner: ProviderTurnRunner,
) -> PerformerTurnResult:
    workspace = Path(request.workspace_path)
    read_only = request.context.turn_kind in {"plan", "gate"}
    before = _workspace_snapshot(workspace, required=read_only)
    prompt, schema = _prompt_and_schema(request)
    output = await provider_runner(
        workspace,
        prompt,
        request.thread_id or None,
        schema,
    )
    changed = sorted(
        _workspace_changes(
            before,
            _workspace_snapshot(workspace, required=read_only),
        )
    )
    if request.context.turn_kind == "plan":
        if changed:
            raise ManagedTurnError(
                "plan_turn_changed_files",
                f"plan_turn_changed_files:{','.join(changed)}",
            )
        if output.runtime_wait is not None:
            return _result(request, output, runtime_wait=output.runtime_wait)
        try:
            validate_plan(output.structured_result)
        except ContractValidationError as exc:
            raise ManagedTurnError("invalid_plan_result", str(exc)) from exc
        return _result(request, output, plan=Plan.from_dict(output.structured_result))

    if request.context.turn_kind == "execute":
        assert request.task is not None
        undeclared = [
            path
            for path in changed
            if not _within_file_scope(path, request.task.files_likely_touched)
        ]
        if undeclared:
            raise ManagedTurnError(
                "execute_turn_changed_file_outside_scope",
                f"execute_turn_changed_file_outside_scope:{','.join(undeclared)}",
            )
        if output.runtime_wait is not None:
            return _result(request, output, runtime_wait=output.runtime_wait)
        execute_result = ExecuteResult.from_dict(output.structured_result)
        if changed and not execute_result.changed_files:
            execute_result = replace(execute_result, changed_files=changed)
        return _result(request, output, execute_result=execute_result)

    if changed:
        raise ManagedTurnError(
            "gate_turn_changed_files",
            f"gate_turn_changed_files:{','.join(changed)}",
        )
    if output.runtime_wait is not None:
        return _result(request, output, runtime_wait=output.runtime_wait)
    return _result(
        request,
        output,
        gate_result=GateResult.from_dict(output.structured_result),
    )


def _result(
    request: PerformerTurnRequest,
    output: ProviderTurnOutput,
    *,
    plan: Plan | None = None,
    execute_result: ExecuteResult | None = None,
    gate_result: GateResult | None = None,
    runtime_wait: RuntimeWait | None = None,
) -> PerformerTurnResult:
    return PerformerTurnResult(
        protocol_version=request.protocol_version,
        context=request.context,
        thread_id=output.thread_id,
        plan=plan,
        execute_result=execute_result,
        gate_result=gate_result,
        runtime_wait=runtime_wait,
        events=output.events,
    )


def _prompt_and_schema(
    request: PerformerTurnRequest,
) -> tuple[str, dict[str, Any]]:
    if request.context.turn_kind == "plan":
        return (
            "Create an ordered plan for this delegated Linear issue. Do not change files. "
            "Return only the requested JSON plan. Each task needs an objective, 1-5 "
            "acceptance criteria, one verification command, a non-empty file scope, and "
            "set approval_required when human approval is needed.\n\n"
            f"Issue:\n{request.issue_description}",
            PLAN_SCHEMA,
        )
    assert request.task is not None
    if request.context.turn_kind == "execute":
        task = request.task
        return (
            f"Execute task {task.id} only. Keep changes within: "
            f"{', '.join(task.files_likely_touched)}.\n"
            f"Objective: {task.objective}\n"
            f"Acceptance: {'; '.join(task.acceptance_criteria)}\n"
            f"Verification command: {' && '.join(task.verification_commands)}\n"
            "Return only the execute result JSON.",
            EXECUTE_SCHEMA,
        )
    task = request.task
    return (
        f"Review task {task.id} read-only. Do not change files.\n"
        f"Acceptance criteria: {'; '.join(task.acceptance_criteria)}\n"
        f"Verification evidence: {request.evidence}\n"
        "Return the single gate result JSON with score, rubric, threshold, and provenance.",
        GATE_SCHEMA,
    )


def _workspace_snapshot(workspace: Path, *, required: bool = False) -> _WorkspaceSnapshot:
    if not _git_command(
        workspace,
        "rev-parse",
        "--is-inside-work-tree",
        required=required,
    ).strip() == b"true":
        return _WorkspaceSnapshot(is_git=False, files={}, index_sha256="")
    paths: set[str] = set()
    for arguments in (
        ("diff", "--name-only", "-z", "--relative"),
        ("diff", "--cached", "--name-only", "-z", "--relative"),
        ("ls-files", "--others", "--exclude-standard", "-z"),
        ("ls-files", "--deleted", "-z"),
    ):
        output = _git_command(workspace, *arguments, required=required)
        paths.update(
            item.decode("utf-8", errors="surrogateescape")
            for item in output.split(b"\x00")
            if item
        )
    files = {path: _file_fingerprint(workspace / path) for path in paths}
    index_patch = _git_command(
        workspace,
        "diff",
        "--cached",
        "--binary",
        required=required,
    )
    return _WorkspaceSnapshot(
        is_git=True,
        files=files,
        index_sha256=hashlib.sha256(index_patch).hexdigest(),
    )


def _workspace_changes(
    before: _WorkspaceSnapshot,
    after: _WorkspaceSnapshot,
) -> set[str]:
    if not before.is_git or not after.is_git:
        return set()
    paths = set(before.files) | set(after.files)
    changed = {
        path for path in paths if before.files.get(path) != after.files.get(path)
    }
    if before.index_sha256 != after.index_sha256:
        changed.update(paths)
    return changed


def _git_command(
    workspace: Path,
    *arguments: str,
    required: bool = False,
) -> bytes:
    try:
        completed = subprocess.run(
            ["git", "-C", str(workspace), *arguments],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        if required:
            raise ManagedTurnError(
                "workspace_snapshot_failed",
                f"workspace_snapshot_failed:{arguments[0]}",
            ) from exc
        return b""
    if completed.returncode != 0:
        if required:
            raise ManagedTurnError(
                "workspace_snapshot_failed",
                f"workspace_snapshot_failed:{arguments[0]}",
            )
        return b""
    return bytes(completed.stdout)


def _file_fingerprint(path: Path) -> str:
    try:
        metadata = path.lstat()
    except OSError:
        return "missing"
    digest = hashlib.sha256()
    digest.update(str(stat.S_IFMT(metadata.st_mode)).encode("ascii"))
    digest.update(str(stat.S_IMODE(metadata.st_mode)).encode("ascii"))
    if stat.S_ISLNK(metadata.st_mode):
        try:
            digest.update(path.readlink().as_posix().encode("utf-8", errors="surrogateescape"))
        except OSError:
            digest.update(b"unreadable-link")
    elif stat.S_ISREG(metadata.st_mode):
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(65_536), b""):
                    digest.update(chunk)
        except OSError:
            digest.update(b"unreadable-file")
    return digest.hexdigest()


def _within_file_scope(path: str, declared: list[str]) -> bool:
    normalized = path.strip().lstrip("./")
    for candidate in declared:
        scope = str(candidate).strip().lstrip("./").rstrip("/")
        if normalized == scope or normalized.startswith(f"{scope}/"):
            return True
    return False


__all__ = [
    "ManagedTurnError",
    "ProviderTurnOutput",
    "ProviderTurnRunner",
    "run_managed_turn",
]
