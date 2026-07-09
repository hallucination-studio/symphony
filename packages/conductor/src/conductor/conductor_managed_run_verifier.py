from __future__ import annotations

import hashlib
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from performer_api.managed_runs import WorkItem, WorkItemResult


@dataclass(frozen=True)
class LocalVerifierOutcome:
    passed: bool
    gate_status: str
    evidence: dict[str, Any] = field(default_factory=dict)


def run_local_verifier(
    work_item: WorkItem,
    result: WorkItemResult,
    *,
    source_workspace: Path,
    state_root: Path,
    verify_attempt_id: str,
) -> LocalVerifierOutcome:
    workspace_result = _detached_worktree(source_workspace, state_root, verify_attempt_id)
    if not workspace_result.passed:
        return workspace_result
    workspace = Path(str(workspace_result.evidence["workspace_path"]))
    materialize_error = _materialize_declared_changes(result, source_workspace, workspace)
    if materialize_error:
        return LocalVerifierOutcome(False, materialize_error, workspace_result.evidence)
    baseline_error = _commit_verification_baseline(workspace)
    if baseline_error:
        return LocalVerifierOutcome(False, baseline_error, workspace_result.evidence)
    hash_error = _artifact_hash_error(result, workspace)
    if hash_error:
        return LocalVerifierOutcome(False, hash_error, workspace_result.evidence)
    for command in work_item.verification.green_commands:
        if command not in result.tests.get("green_commands_run", []):
            return LocalVerifierOutcome(False, f"verification missing:{command}", workspace_result.evidence)
        failure = _run_command(command, workspace)
        if failure:
            return LocalVerifierOutcome(False, failure, workspace_result.evidence)
    mutation = _mutation_status(workspace)
    if mutation:
        return LocalVerifierOutcome(False, f"verification_workspace_mutated:{'|'.join(mutation)}", workspace_result.evidence)
    return LocalVerifierOutcome(True, "verification passed", workspace_result.evidence)


def _detached_worktree(source_workspace: Path, state_root: Path, verify_attempt_id: str) -> LocalVerifierOutcome:
    workspace = state_root / "local-verifier-worktrees" / _safe_id(verify_attempt_id)
    _remove_worktree(source_workspace, workspace)
    commit = _git_text(source_workspace, "rev-parse", "HEAD")
    if not commit:
        return LocalVerifierOutcome(False, "verification_git_repo_required", {"workspace_path": str(workspace)})
    result = _git(source_workspace, "worktree", "add", "--detach", str(workspace), commit, check=False)
    if result.returncode != 0:
        return LocalVerifierOutcome(False, f"verification_worktree_create_failed:{_tail(result.stderr)}", {"workspace_path": str(workspace)})
    return LocalVerifierOutcome(True, "workspace ready", {"workspace_path": str(workspace), "commit_sha": commit})


def _materialize_declared_changes(result: WorkItemResult, source_workspace: Path, verifier_workspace: Path) -> str:
    for changed in result.changed_files:
        relative = _safe_relative_path(changed.path)
        if relative is None:
            return f"verification_declared_path_invalid:{changed.path}"
        source = source_workspace / relative
        target = verifier_workspace / relative
        action = changed.action.lower()
        if action in {"deleted", "removed", "delete", "remove"}:
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            continue
        if not source.is_file():
            return f"verification_declared_file_missing:{changed.path}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return ""


def _commit_verification_baseline(workspace: Path) -> str:
    if not _mutation_status(workspace):
        return ""
    add = _git(workspace, "add", "-A", check=False)
    if add.returncode != 0:
        return f"verification_baseline_add_failed:{_tail(add.stderr)}"
    commit = subprocess.run(
        [
            "git",
            "-C",
            str(workspace),
            "-c",
            "user.email=verifier@example.invalid",
            "-c",
            "user.name=Managed Run Verifier",
            "commit",
            "-m",
            "managed-run verification baseline",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if commit.returncode != 0:
        return f"verification_baseline_commit_failed:{_tail(commit.stderr)}"
    return ""


def _artifact_hash_error(result: WorkItemResult, workspace: Path) -> str:
    expected = result.tests.get("artifact_hashes") if isinstance(result.tests, dict) else []
    if not isinstance(expected, list):
        return ""
    for artifact in expected:
        if not isinstance(artifact, dict):
            continue
        relative = str(artifact.get("path") or artifact.get("uri") or "")
        expected_sha = str(artifact.get("sha256") or "")
        if not relative or not expected_sha:
            continue
        path = workspace / relative
        if not path.is_file():
            return f"artifact_missing:{relative}"
        if _sha256(path) != expected_sha:
            return f"artifact_hash_mismatch:{relative}"
    return ""


def _run_command(command: str, workspace: Path) -> str:
    completed = subprocess.run(command, cwd=workspace, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if completed.returncode == 0:
        return ""
    return f"verification_command_failed:{_safe_command(command)}:exit_{completed.returncode}:{_tail(completed.stdout + completed.stderr)}"


def _mutation_status(workspace: Path) -> list[str]:
    output = _git_text(workspace, "status", "--porcelain")
    changed: list[str] = []
    for line in output.splitlines():
        if line.strip():
            changed.append(line[3:].strip() or line.strip())
    return sorted(changed)


def _remove_worktree(repo: Path, workspace: Path) -> None:
    if not workspace.exists():
        return
    _git(repo, "worktree", "remove", "--force", str(workspace), check=False)
    if workspace.exists():
        shutil.rmtree(workspace)


def _git_text(repo: Path, *args: str) -> str:
    result = _git(repo, *args, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def _git(repo: Path, *args: str, check: bool) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_command(command: str) -> str:
    return str(command or "").replace("\n", " ").replace("\r", " ").strip()[:200]


def _safe_relative_path(value: str) -> Path | None:
    path = Path(str(value or ""))
    if path.is_absolute() or any(part == ".." for part in path.parts):
        return None
    return path if str(path) not in {"", "."} else None


def _tail(value: str) -> str:
    return str(value or "no output").replace("\n", " ").replace("\r", " ").strip()[-200:]


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:120] or "verify"


__all__ = ["LocalVerifierOutcome", "run_local_verifier"]
