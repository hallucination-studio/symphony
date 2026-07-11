from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from conductor.conductor_managed_run_execution import ManagedRunExecutionError, freeze_execution_handoff
from conductor.conductor_managed_run_gates import GateSnapshot
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
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok\\\\n'\""
    result = _result(command)
    handoff = freeze_execution_handoff(result, execution_workspace=repo)

    outcome = run_local_verifier(
        _gate(command),
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=handoff.artifact_hashes,
    )

    assert outcome.passed is True
    assert outcome.gate_status == "verification passed"
    assert outcome.score == 3
    assert outcome.evidence["workspace_path"] != str(repo)
    assert Path(outcome.evidence["workspace_path"]).is_dir()
    assert _git_text(Path(outcome.evidence["workspace_path"]), "branch", "--show-current") == ""


def test_local_verifier_rejects_missing_frozen_execution_commit(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    command = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok\\\\n'\""

    outcome = run_local_verifier(
        _gate(command),
        _result(command),
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha="missing",
        artifact_hashes=[],
    )

    assert outcome.passed is False
    assert outcome.gate_status == "verification_execute_commit_missing"


def test_local_verifier_uses_frozen_execution_commit_after_workspace_changes(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok\\\\n'\""
    result = _result(command, artifact_hashes=[])

    handoff = freeze_execution_handoff(result, execution_workspace=repo)
    (repo / "result.txt").write_text("mutated\n", encoding="utf-8")
    outcome = run_local_verifier(
        _gate(command),
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=handoff.artifact_hashes,
    )

    assert outcome.passed is True
    assert outcome.evidence["commit_sha"] == handoff.commit_sha
    assert handoff.commit_sha != handoff.base_revision


def test_local_verifier_blocks_artifact_hash_mismatch_before_running_gate(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; Path('should-not-run.txt').write_text('bad')\""
    result = _result(command)
    handoff = freeze_execution_handoff(result, execution_workspace=repo)

    outcome = run_local_verifier(
        _gate(command),
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=[{"path": "result.txt", "sha256": "wrong"}],
    )

    workspace = Path(outcome.evidence["workspace_path"])
    assert outcome.passed is False
    assert outcome.gate_status == "artifact_hash_mismatch:result.txt"
    assert not (workspace / "should-not-run.txt").exists()


def test_local_verifier_blocks_gate_workspace_mutation_without_touching_source_repo(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; Path('verifier-mutated.txt').write_text('bad')\""
    result = _result(command)
    handoff = freeze_execution_handoff(result, execution_workspace=repo)

    outcome = run_local_verifier(
        _gate(command),
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=handoff.artifact_hashes,
    )

    assert outcome.passed is False
    assert outcome.gate_status == "verification_workspace_mutated:verifier-mutated.txt"
    assert not (repo / "verifier-mutated.txt").exists()
    assert (Path(outcome.evidence["workspace_path"]) / "verifier-mutated.txt").exists()


def test_local_verifier_rejects_tampered_frozen_gate_before_running_commands(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; Path('should-not-run.txt').write_text('bad')\""
    result = _result(command)
    handoff = freeze_execution_handoff(result, execution_workspace=repo)
    gate = GateSnapshot.from_dict({**_gate(command).to_dict(), "content_hash": "sha256:tampered"})

    outcome = run_local_verifier(
        gate,
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=handoff.artifact_hashes,
    )

    assert outcome.passed is False
    assert outcome.score == 0
    assert outcome.gate_status == "gate_snapshot_invalid:content_hash_mismatch"
    assert not (Path(outcome.evidence["workspace_path"]) / "should-not-run.txt").exists()


def test_local_verifier_keeps_advisory_gate_failure_non_blocking(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    command = "python -c \"from pathlib import Path; assert Path('result.txt').read_text() == 'ok\\\\n'\""
    result = _result(command)
    handoff = freeze_execution_handoff(result, execution_workspace=repo)
    advisory_gate = GateSnapshot.from_work_item(
        run_id="run-1",
        work_item=WorkItem.from_dict(
            {
                **_work_item(command).to_dict(),
                "verification": {
                    "red_command": command,
                    "green_commands": [command],
                    "runtime_checks": ["python -c \"import sys; sys.exit(9)\""],
                },
            }
        ),
        plan_version=1,
        creator_attempt_id="plan-1",
        created_at="2026-07-10T00:00:00Z",
    )

    outcome = run_local_verifier(
        advisory_gate,
        result,
        source_workspace=repo,
        state_root=tmp_path / "state",
        verify_attempt_id="verify-1",
        execute_commit_sha=handoff.commit_sha,
        artifact_hashes=handoff.artifact_hashes,
    )

    assert outcome.passed is True
    assert outcome.score == 3
    assert outcome.evidence["advisory_failures"][0].startswith("verification_command_failed:")


def test_freeze_execution_handoff_rejects_unreported_workspace_changes(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "README.md", "base\n", "base")
    _git(repo, "checkout", "-b", "managed-run/run-1/wi-1")
    (repo / "result.txt").write_text("ok\n", encoding="utf-8")
    (repo / "unreported.txt").write_text("unexpected\n", encoding="utf-8")
    command = "python -c \"print('unused')\""

    with pytest.raises(ManagedRunExecutionError, match="execution_undeclared_workspace_changes:unreported.txt"):
        freeze_execution_handoff(_result(command), execution_workspace=repo)


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


def _gate(command: str) -> GateSnapshot:
    return GateSnapshot.from_work_item(
        run_id="run-1",
        work_item=_work_item(command),
        plan_version=1,
        creator_attempt_id="plan-1",
        created_at="2026-07-10T00:00:00Z",
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


def _git_text(repo: Path, *args: str) -> str:
    return _git(repo, *args).stdout.strip()


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
