from __future__ import annotations

from pathlib import Path
import subprocess

from performer.repository_handoff import build_repository_handoff_report


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _init_repo(repo: Path) -> None:
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    (repo / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-m", "initial")


def test_repository_handoff_bundle_captures_git_patch_and_untracked_files(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "tracked.txt").write_text("after\n", encoding="utf-8")
    (repo / "new.txt").write_text("hello handoff\n", encoding="utf-8")
    bundle_root = tmp_path / "state" / "handoffs"

    report = build_repository_handoff_report(
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workspace_path=repo,
        structured_result={"tests": "pytest"},
        bundle_root=bundle_root,
    )

    assert report.issue_id == "issue-1"
    assert report.workspace_path == str(repo)
    assert report.git_snapshot["is_git_repo"] is True
    assert "tracked.txt" in report.git_snapshot["changed_files"]
    assert "new.txt" in report.git_snapshot["changed_files"]
    assert Path(report.bundle["path"]).is_relative_to(bundle_root)
    patch_path = Path(report.bundle["changes_patch_path"])
    assert patch_path.exists()
    assert "after" in patch_path.read_text(encoding="utf-8", errors="replace")
    untracked_copy = Path(report.bundle["path"]) / "untracked" / "new.txt"
    assert untracked_copy.read_text(encoding="utf-8") == "hello handoff\n"
    manifest_paths = {item["path"] for item in report.artifact_manifest}
    assert "untracked/new.txt" in manifest_paths


def test_repository_handoff_report_supports_workspace_without_git(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "note.txt").write_text("manual review\n", encoding="utf-8")

    report = build_repository_handoff_report(
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workspace_path=workspace,
        structured_result=None,
        bundle_root=tmp_path / "handoffs",
    )

    assert report.git_snapshot["is_git_repo"] is False
    assert report.recommended_next_action == "manual_integration_review"
    assert Path(report.bundle["manifest_path"]).exists()
