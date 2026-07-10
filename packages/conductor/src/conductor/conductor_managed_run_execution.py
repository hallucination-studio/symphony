from __future__ import annotations

import hashlib
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from performer_api.managed_runs import WorkItemResult


class ManagedRunExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExecutionWorkspace:
    workspace_path: Path
    branch_name: str
    base_revision: str


@dataclass(frozen=True)
class ExecutionHandoff:
    base_revision: str
    branch_name: str
    commit_sha: str
    artifact_hashes: list[dict[str, str]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "base_revision": self.base_revision,
            "branch_name": self.branch_name,
            "commit_sha": self.commit_sha,
            "artifact_hashes": [dict(item) for item in self.artifact_hashes],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecutionHandoff:
        return cls(
            base_revision=str(payload.get("base_revision") or ""),
            branch_name=str(payload.get("branch_name") or ""),
            commit_sha=str(payload.get("commit_sha") or ""),
            artifact_hashes=[dict(item) for item in payload.get("artifact_hashes") or [] if isinstance(item, dict)],
        )


def prepare_execution_worktree(
    repo_path: Path,
    *,
    state_root: Path,
    run_id: str,
    work_item_id: str,
) -> ExecutionWorkspace:
    repo = Path(repo_path)
    base_revision = _git_text(repo, "rev-parse", "HEAD")
    if not base_revision:
        raise ManagedRunExecutionError("execution_git_repo_required")
    branch_name = f"managed-run/{_safe_id(run_id)}/{_safe_id(work_item_id)}"
    workspace = state_root / "managed-run-worktrees" / _safe_id(f"{run_id}-{work_item_id}")
    _remove_worktree(repo, workspace)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    result = _git(repo, "worktree", "add", "-B", branch_name, str(workspace), base_revision, check=False)
    if result.returncode != 0:
        raise ManagedRunExecutionError(f"execution_worktree_create_failed:{_tail(result.stderr)}")
    return ExecutionWorkspace(workspace_path=workspace, branch_name=branch_name, base_revision=base_revision)


def freeze_execution_handoff(
    result: WorkItemResult,
    *,
    execution_workspace: Path,
    expected_base_revision: str = "",
    expected_branch_name: str = "",
) -> ExecutionHandoff:
    workspace = Path(execution_workspace)
    base_revision = _git_text(workspace, "rev-parse", "HEAD")
    if not base_revision:
        raise ManagedRunExecutionError("execution_git_repo_required")
    branch_name = _git_text(workspace, "branch", "--show-current")
    if not branch_name.startswith("managed-run/"):
        raise ManagedRunExecutionError("managed_run_execution_branch_required")
    if expected_base_revision and base_revision != expected_base_revision:
        raise ManagedRunExecutionError("execution_head_changed_during_turn")
    if expected_branch_name and branch_name != expected_branch_name:
        raise ManagedRunExecutionError("execution_branch_changed_during_turn")
    declared_paths = _declared_paths(result)
    actual_paths = _workspace_changed_paths(workspace)
    undeclared = sorted(actual_paths - declared_paths)
    if undeclared:
        raise ManagedRunExecutionError(f"execution_undeclared_workspace_changes:{'|'.join(undeclared)}")
    missing = sorted(declared_paths - actual_paths)
    if missing:
        raise ManagedRunExecutionError(f"execution_declared_changes_missing:{'|'.join(missing)}")
    if declared_paths:
        staged = _git(workspace, "add", "-A", "--", *sorted(declared_paths), check=False)
        if staged.returncode != 0:
            raise ManagedRunExecutionError(f"execution_commit_add_failed:{_tail(staged.stderr)}")
        staged_paths = _staged_paths(workspace)
        if staged_paths != declared_paths:
            raise ManagedRunExecutionError(f"execution_commit_scope_mismatch:{'|'.join(sorted(staged_paths ^ declared_paths))}")
        committed = _git(
            workspace,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.email=managed-run@example.invalid",
            "-c",
            "user.name=Managed Run",
            "commit",
            "-m",
            f"managed run {result.work_item_id} execution",
            check=False,
        )
        if committed.returncode != 0:
            raise ManagedRunExecutionError(f"execution_commit_failed:{_tail(committed.stderr)}")
    commit_sha = _git_text(workspace, "rev-parse", "HEAD")
    if not commit_sha:
        raise ManagedRunExecutionError("execution_commit_missing")
    remaining = _workspace_changed_paths(workspace)
    if remaining:
        raise ManagedRunExecutionError(f"execution_workspace_not_clean_after_commit:{'|'.join(sorted(remaining))}")
    return ExecutionHandoff(
        base_revision=base_revision,
        branch_name=branch_name,
        commit_sha=commit_sha,
        artifact_hashes=_artifact_hashes_at_commit(workspace, commit_sha, declared_paths),
    )


def _declared_paths(result: WorkItemResult) -> set[str]:
    paths: set[str] = set()
    for changed in result.changed_files:
        path = _safe_relative_path(changed.path)
        if path is None:
            raise ManagedRunExecutionError(f"execution_declared_path_invalid:{changed.path}")
        paths.add(path.as_posix())
    return paths


def _workspace_changed_paths(workspace: Path) -> set[str]:
    paths = _git_path_set(workspace, "diff", "--name-only", "--no-renames")
    paths.update(_git_path_set(workspace, "diff", "--cached", "--name-only", "--no-renames"))
    paths.update(_git_path_set(workspace, "ls-files", "--others", "--exclude-standard"))
    return paths


def _staged_paths(workspace: Path) -> set[str]:
    return _git_path_set(workspace, "diff", "--cached", "--name-only", "--no-renames")


def _git_path_set(workspace: Path, *args: str) -> set[str]:
    result = _git(workspace, *args, check=False)
    if result.returncode != 0:
        raise ManagedRunExecutionError(f"execution_git_status_failed:{_tail(result.stderr)}")
    paths: set[str] = set()
    for raw in result.stdout.splitlines():
        path = _safe_relative_path(raw)
        if path is None:
            raise ManagedRunExecutionError(f"execution_git_path_invalid:{raw}")
        paths.add(path.as_posix())
    return paths


def _artifact_hashes_at_commit(workspace: Path, commit_sha: str, paths: set[str]) -> list[dict[str, str]]:
    artifacts: list[dict[str, str]] = []
    for path in sorted(paths):
        artifact: dict[str, str] = {"uri": path, "path": path}
        content = _git_bytes(workspace, "show", f"{commit_sha}:{path}")
        if content.returncode == 0:
            artifact["sha256"] = hashlib.sha256(content.stdout).hexdigest()
        artifacts.append(artifact)
    return artifacts


def _remove_worktree(repo: Path, workspace: Path) -> None:
    if not workspace.exists():
        return
    _git(repo, "worktree", "remove", "--force", str(workspace), check=False)
    if workspace.exists():
        shutil.rmtree(workspace)


def _git_text(workspace: Path, *args: str) -> str:
    result = _git(workspace, *args, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def _git(workspace: Path, *args: str, check: bool) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(workspace), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check)


def _git_bytes(workspace: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", "-C", str(workspace), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def _safe_relative_path(value: str) -> Path | None:
    path = Path(str(value or ""))
    if path.is_absolute() or any(part == ".." for part in path.parts):
        return None
    return path if str(path) not in {"", "."} else None


def _safe_id(value: str) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in value)[:120] or "work-item"


def _tail(value: str) -> str:
    return str(value or "no output").replace("\n", " ").replace("\r", " ").strip()[-200:]


__all__ = ["ExecutionHandoff", "ExecutionWorkspace", "ManagedRunExecutionError", "freeze_execution_handoff", "prepare_execution_worktree"]
