from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from conductor.conductor_managed_run_verifier import run_local_verifier
from performer_api.managed_runs import (
    ChangedFile,
    ParallelizationPolicy,
    WorkItem,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemVerification,
)


def test_local_verifier_runs_gate_in_detached_disposable_worktree(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "result.txt", "ok\n", "result")
    command = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok\\\\n'\""

    outcome = run_local_verifier(
        _work_item(command),
        _result(command, artifact_hashes=[{"path": "result.txt", "sha256": _sha256(repo / "result.txt")}]),
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
    )

    assert outcome.passed is True
    assert outcome.gate_status == "verification passed"
    assert outcome.evidence["workspace_path"] != str(repo)
    assert Path(outcome.evidence["workspace_path"]).is_dir()
    assert _git_text(Path(outcome.evidence["workspace_path"]), "branch", "--show-current") == ""


def test_local_verifier_blocks_artifact_hash_mismatch_before_running_gate(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "result.txt", "ok\n", "result")
    command = "python -c \"from pathlib import Path; Path('should-not-run.txt').write_text('bad')\""

    outcome = run_local_verifier(
        _work_item(command),
        _result(command, artifact_hashes=[{"path": "result.txt", "sha256": "wrong"}]),
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
    )

    workspace = Path(outcome.evidence["workspace_path"])
    assert outcome.passed is False
    assert outcome.gate_status == "artifact_hash_mismatch:result.txt"
    assert not (workspace / "should-not-run.txt").exists()


def test_local_verifier_blocks_gate_workspace_mutation_without_touching_source_repo(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "result.txt", "ok\n", "result")
    command = "python -c \"from pathlib import Path; Path('verifier-mutated.txt').write_text('bad')\""

    outcome = run_local_verifier(
        _work_item(command),
        _result(command),
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
    )

    assert outcome.passed is False
    assert outcome.gate_status == "verification_workspace_mutated:verifier-mutated.txt"
    assert not (repo / "verifier-mutated.txt").exists()
    assert (Path(outcome.evidence["workspace_path"]) / "verifier-mutated.txt").exists()


def _work_item(command: str) -> WorkItem:
    return WorkItem(
        id="wi-1",
        title="Implement result",
        objective="Create a result file",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=["result exists"],
        verification=WorkItemVerification(red_command=command, green_commands=[command]),
        dependencies=[],
        estimated_scope="S",
        files_likely_touched=["result.txt"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="single item"),
    )


def _result(command: str, *, artifact_hashes: list[dict[str, str]] | None = None) -> WorkItemResult:
    return WorkItemResult(
        work_item_id="wi-1",
        status_claimed=WorkItemResultStatus.READY_FOR_REVIEW,
        changed_files=[ChangedFile(path="result.txt", action="created", planned=True, reason="result", handling="kept", verification=[command])],
        undeclared_files=[],
        tests={
            "red_command": command,
            "red_observed": True,
            "green_commands_run": [command],
            "secret_scan_passed": True,
            "artifact_hashes": artifact_hashes or [],
        },
        acceptance_results=[{"criterion": "result exists", "status": "passed"}],
        blocked_reason=None,
        plan_revision=None,
        notes="ready",
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    return repo


def _write_commit(repo: Path, path: str, text: str, message: str) -> None:
    target = repo / path
    target.write_text(text, encoding="utf-8")
    _git(repo, "add", path)
    _git(repo, "commit", "-m", message)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git_text(repo: Path, *args: str) -> str:
    return _git(repo, *args).stdout.strip()


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
