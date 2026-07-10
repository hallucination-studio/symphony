from __future__ import annotations

import hashlib
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from performer_api.managed_runs import GateSnapshot, GateStepSource, WorkItemResult


@dataclass(frozen=True)
class LocalVerifierOutcome:
    passed: bool
    gate_status: str
    evidence: dict[str, Any] = field(default_factory=dict)
    score: int = 0


def run_local_verifier(
    gate_snapshot: GateSnapshot,
    result: WorkItemResult,
    *,
    source_workspace: Path,
    state_root: Path,
    verify_attempt_id: str,
    execute_commit_sha: str,
    artifact_hashes: list[dict[str, Any]],
) -> LocalVerifierOutcome:
    workspace_result = _detached_worktree(source_workspace, state_root, verify_attempt_id, execute_commit_sha)
    if not workspace_result.passed:
        return workspace_result
    evidence = {**workspace_result.evidence, "gate_snapshot_hash": gate_snapshot.content_hash}
    gate_errors = gate_snapshot.validation_errors()
    if gate_snapshot.work_item_id != result.work_item_id:
        gate_errors.append("work_item_id_mismatch")
    if gate_errors:
        return LocalVerifierOutcome(False, f"gate_snapshot_invalid:{','.join(gate_errors)}", evidence)
    workspace = Path(str(evidence["workspace_path"]))
    hash_error = _artifact_hash_error(artifact_hashes, workspace)
    if hash_error:
        return LocalVerifierOutcome(False, hash_error, evidence)
    advisory_failures: list[str] = []
    for step in gate_snapshot.verification_procedure:
        failure = _run_command(step.command, workspace)
        if failure:
            if step.source is GateStepSource.PLANNER_INFERRED:
                advisory_failures.append(failure)
                continue
            return LocalVerifierOutcome(False, failure, evidence)
    mutation = _mutation_status(workspace)
    if mutation:
        return LocalVerifierOutcome(False, f"verification_workspace_mutated:{'|'.join(mutation)}", evidence)
    if advisory_failures:
        evidence["advisory_failures"] = advisory_failures
    return LocalVerifierOutcome(True, "verification passed", evidence, score=3)


def _detached_worktree(source_workspace: Path, state_root: Path, verify_attempt_id: str, execute_commit_sha: str) -> LocalVerifierOutcome:
    workspace = state_root / "local-verifier-worktrees" / _safe_id(verify_attempt_id)
    _remove_worktree(source_workspace, workspace)
    commit = _git_text(source_workspace, "rev-parse", "--verify", f"{execute_commit_sha}^{{commit}}")
    if not commit:
        return LocalVerifierOutcome(False, "verification_execute_commit_missing", {"workspace_path": str(workspace)})
    result = _git(source_workspace, "worktree", "add", "--detach", str(workspace), commit, check=False)
    if result.returncode != 0:
        return LocalVerifierOutcome(False, f"verification_worktree_create_failed:{_tail(result.stderr)}", {"workspace_path": str(workspace)})
    return LocalVerifierOutcome(True, "workspace ready", {"workspace_path": str(workspace), "commit_sha": commit})


def _artifact_hash_error(expected: list[dict[str, Any]], workspace: Path) -> str:
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


def _tail(value: str) -> str:
    return str(value or "no output").replace("\n", " ").replace("\r", " ").strip()[-200:]


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:120] or "verify"


__all__ = ["LocalVerifierOutcome", "run_local_verifier"]
