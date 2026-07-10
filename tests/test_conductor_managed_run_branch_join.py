from __future__ import annotations

import subprocess
from pathlib import Path

from conductor.conductor_managed_run_branch_join import join_verified_branches


def test_managed_run_branch_join_merges_verified_manifest_branches(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "a.txt", "base\n", "base")
    first_commit = _branch_commit(repo, "managed-run/wi-1", "a.txt", "base\none\n", "wi-1")
    _run(repo, "checkout", "main")
    second_commit = _branch_commit(repo, "managed-run/wi-2", "b.txt", "two\n", "wi-2")
    _run(repo, "checkout", "main")

    result = join_verified_branches(
        repo,
        run_id="run-1",
        downstream_work_item_id="wi-3",
        manifests=[
            {"work_item_id": "wi-1", "branch_name": "managed-run/wi-1", "commit_sha": first_commit, "verify_attempt_id": "verify-1"},
            {"work_item_id": "wi-2", "branch_name": "managed-run/wi-2", "commit_sha": second_commit, "verify_attempt_id": "verify-2"},
        ],
        state_root=tmp_path / "state",
    )

    assert result["status"] == "integrated"
    assert result["merged_manifest_ids"] == ["verify-1", "verify-2"]
    assert Path(result["worktree_path"]).is_relative_to(tmp_path / "state")
    assert (Path(result["worktree_path"]) / "a.txt").read_text(encoding="utf-8") == "base\none\n"
    assert (Path(result["worktree_path"]) / "b.txt").read_text(encoding="utf-8") == "two\n"


def test_managed_run_branch_join_blocks_on_conflicting_verified_branches(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "same.txt", "base\n", "base")
    first_commit = _branch_commit(repo, "managed-run/wi-1", "same.txt", "one\n", "wi-1")
    _run(repo, "checkout", "main")
    second_commit = _branch_commit(repo, "managed-run/wi-2", "same.txt", "two\n", "wi-2")
    _run(repo, "checkout", "main")

    result = join_verified_branches(
        repo,
        run_id="run-1",
        downstream_work_item_id="wi-3",
        manifests=[
            {"work_item_id": "wi-1", "branch_name": "managed-run/wi-1", "commit_sha": first_commit, "verify_attempt_id": "verify-1"},
            {"work_item_id": "wi-2", "branch_name": "managed-run/wi-2", "commit_sha": second_commit, "verify_attempt_id": "verify-2"},
        ],
        state_root=tmp_path / "state",
    )

    assert result["status"] == "conflicted"
    assert result["conflict_files"] == ["same.txt"]
    assert result["action_required"] == "approve_resolver_work_item"


def test_managed_run_branch_join_uses_manifest_commit_not_moved_branch_head(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write_commit(repo, "a.txt", "base\n", "base")
    recorded_commit = _branch_commit(repo, "managed-run/wi-1", "a.txt", "recorded\n", "recorded")
    _write_commit(repo, "a.txt", "moved\n", "moved")
    _run(repo, "checkout", "main")

    result = join_verified_branches(
        repo,
        run_id="run-1",
        downstream_work_item_id="wi-2",
        manifests=[
            {"work_item_id": "wi-1", "branch_name": "managed-run/wi-1", "commit_sha": recorded_commit, "verify_attempt_id": "verify-1"},
        ],
        state_root=tmp_path / "state",
    )

    assert result["status"] == "integrated"
    assert (Path(result["worktree_path"]) / "a.txt").read_text(encoding="utf-8") == "recorded\n"


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _run(repo, "init", "-b", "main")
    _run(repo, "config", "user.email", "test@example.com")
    _run(repo, "config", "user.name", "Test User")
    return repo


def _branch_commit(repo: Path, branch: str, path: str, text: str, message: str) -> str:
    _run(repo, "checkout", "-B", branch)
    _write_commit(repo, path, text, message)
    return _run(repo, "rev-parse", "HEAD").stdout.strip()


def _write_commit(repo: Path, path: str, text: str, message: str) -> None:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    _run(repo, "add", path)
    _run(repo, "commit", "-m", message)


def _run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
