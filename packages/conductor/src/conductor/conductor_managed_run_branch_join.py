from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunState, WorkItemState


@dataclass(frozen=True)
class JoinWorkspace:
    workspace_path: Path | None
    failed: bool = False


def join_verified_branches(
    repo_path: Path,
    *,
    run_id: str,
    downstream_work_item_id: str,
    manifests: list[dict[str, Any]],
) -> dict[str, Any]:
    repo = Path(repo_path)
    branch_name = f"managed-run/{_safe_id(run_id)}/{_safe_id(downstream_work_item_id)}/join"
    worktree_path = repo / ".git" / "symphony-managed-run-joins" / _safe_id(f"{run_id}-{downstream_work_item_id}")
    _remove_worktree(repo, worktree_path)
    base = _git_text(repo, "rev-parse", "HEAD")
    _git(repo, "worktree", "add", "-B", branch_name, str(worktree_path), base, check=True)
    merged: list[str] = []
    for manifest in manifests:
        source_branch = str(manifest.get("branch_name") or "")
        if not source_branch:
            return _blocked(branch_name, worktree_path, merged, "manifest_branch_missing", [])
        result = _git(worktree_path, "merge", "--no-ff", "--no-edit", source_branch, check=False)
        if result.returncode != 0:
            conflicts = _git_text(worktree_path, "diff", "--name-only", "--diff-filter=U").splitlines()
            return _blocked(branch_name, worktree_path, merged, "merge_conflict", sorted(conflicts))
        merged.append(str(manifest.get("verify_attempt_id") or manifest.get("work_item_id") or source_branch))
    return {
        "status": "integrated",
        "branch_name": branch_name,
        "worktree_path": str(worktree_path),
        "merged_manifest_ids": merged,
        "conflict_files": [],
        "action_required": "",
    }


def prepare_verified_dependency_workspace(
    store: Any,
    repo_path: Path,
    *,
    run: dict[str, Any],
    item: dict[str, Any],
) -> JoinWorkspace:
    dependencies = _dependencies(item)
    if not dependencies:
        return JoinWorkspace(Path(repo_path))
    run_id = str(run["run_id"])
    work_item_id = str(item["work_item_id"])
    manifests = _manifests_for_dependencies(store.list_task_output_manifests(run_id), dependencies)
    missing = [dependency for dependency in dependencies if dependency not in {str(manifest.get("work_item_id") or "") for manifest in manifests}]
    if missing:
        reason = f"verified_manifest_missing:{'|'.join(missing)}"
        _block_join(store, run_id, work_item_id, reason, {})
        return JoinWorkspace(None, failed=True)
    result = join_verified_branches(Path(repo_path), run_id=run_id, downstream_work_item_id=work_item_id, manifests=manifests)
    if result.get("status") != "integrated":
        files = "|".join(result.get("conflict_files") or [])
        reason = f"verified_branch_join_conflict:{files or result.get('reason') or 'unknown'}"
        _block_join(store, run_id, work_item_id, reason, result)
        return JoinWorkspace(None, failed=True)
    _append_join_result(store, run_id, result)
    return JoinWorkspace(Path(str(result["worktree_path"])))


def _blocked(branch_name: str, worktree_path: Path, merged: list[str], reason: str, conflict_files: list[str]) -> dict[str, Any]:
    return {
        "status": "conflicted",
        "branch_name": branch_name,
        "worktree_path": str(worktree_path),
        "merged_manifest_ids": merged,
        "conflict_files": conflict_files,
        "reason": reason,
        "action_required": "approve_resolver_work_item",
    }


def _dependencies(item: dict[str, Any]) -> list[str]:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    return [str(dependency) for dependency in payload.get("dependencies") or [] if str(dependency)]


def _manifests_for_dependencies(manifests: list[dict[str, Any]], dependencies: list[str]) -> list[dict[str, Any]]:
    by_work_item = {str(manifest.get("work_item_id") or ""): dict(manifest) for manifest in manifests}
    return [by_work_item[dependency] for dependency in dependencies if dependency in by_work_item]


def _block_join(store: Any, run_id: str, work_item_id: str, reason: str, result: dict[str, Any]) -> None:
    if result:
        _append_join_result(store, run_id, result)
    store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=work_item_id, reason=reason)
    store.update_work_item_state(run_id, work_item_id, WorkItemState.BLOCKED, gate_status=reason)


def _append_join_result(store: Any, run_id: str, result: dict[str, Any]) -> None:
    run = store.get_run(run_id) or {}
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    joins = [dict(item) for item in payload.get("branch_joins") or [] if isinstance(item, dict)]
    joins.append(dict(result))
    store.merge_run_payload(run_id, {"branch_joins": joins})


def _remove_worktree(repo: Path, worktree_path: Path) -> None:
    if not worktree_path.exists():
        return
    _git(repo, "worktree", "remove", "--force", str(worktree_path), check=False)
    if worktree_path.exists():
        shutil.rmtree(worktree_path)


def _git_text(repo: Path, *args: str) -> str:
    result = _git(repo, *args, check=True)
    return result.stdout.strip()


def _git(repo: Path, *args: str, check: bool) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:120]


__all__ = ["JoinWorkspace", "join_verified_branches", "prepare_verified_dependency_workspace"]
