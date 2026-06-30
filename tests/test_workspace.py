from __future__ import annotations

from pathlib import Path
import logging

import pytest

from symphony.config import HooksConfig, WorkspaceConfig
from symphony.workspace import WorkspaceError, WorkspaceManager, sanitize_workspace_key


def test_sanitize_workspace_key_replaces_unsafe_characters() -> None:
    assert sanitize_workspace_key("MT-1 / bad:name") == "MT-1___bad_name"


@pytest.mark.asyncio
async def test_create_for_issue_creates_deterministic_workspace_and_after_create_hook(tmp_path: Path) -> None:
    manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path),
        HooksConfig(after_create="printf created > hook.txt"),
    )

    workspace = await manager.create_for_issue("MT-1")
    reused = await manager.create_for_issue("MT-1")

    assert workspace.path == tmp_path / "MT-1"
    assert workspace.created_now
    assert not reused.created_now
    assert (workspace.path / "hook.txt").read_text(encoding="utf-8") == "created"


@pytest.mark.asyncio
async def test_existing_non_directory_workspace_path_fails(tmp_path: Path) -> None:
    (tmp_path / "MT-1").write_text("file", encoding="utf-8")
    manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())

    with pytest.raises(WorkspaceError) as exc:
        await manager.create_for_issue("MT-1")

    assert exc.value.code == "workspace_path_not_directory"


@pytest.mark.asyncio
async def test_before_run_hook_failure_is_fatal(tmp_path: Path) -> None:
    manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig(before_run="exit 12"))
    workspace = await manager.create_for_issue("MT-1")

    with pytest.raises(WorkspaceError) as exc:
        await manager.run_before_run(workspace.path)

    assert exc.value.code == "hook_failed"


@pytest.mark.asyncio
async def test_before_run_rejects_path_outside_workspace_root(tmp_path: Path) -> None:
    manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "root"), HooksConfig())

    with pytest.raises(WorkspaceError) as exc:
        await manager.run_before_run(tmp_path / "outside")

    assert exc.value.code == "workspace_path_outside_root"


@pytest.mark.asyncio
async def test_cleanup_runs_before_remove_and_removes_workspace(tmp_path: Path) -> None:
    log = tmp_path / "cleanup.log"
    manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path / "root"),
        HooksConfig(before_remove=f"printf removed > {log}"),
    )
    workspace = await manager.create_for_issue("MT-1")

    await manager.remove_for_issue("MT-1")

    assert not workspace.path.exists()
    assert log.read_text(encoding="utf-8") == "removed"


@pytest.mark.asyncio
async def test_nonfatal_after_run_hook_failure_is_logged_and_ignored(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig(after_run="echo bad >&2; exit 7"))
    workspace = await manager.create_for_issue("MT-1")

    await manager.run_after_run(workspace.path)

    assert "symphony_hook outcome=failed hook=after_run" in caplog.text
    assert "exit_code=7" in caplog.text
    assert "bad" in caplog.text


@pytest.mark.asyncio
async def test_hook_failure_log_truncates_large_output(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)
    long_message = "x" * 700
    manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path),
        HooksConfig(after_run=f"printf {long_message}; exit 2"),
    )
    workspace = await manager.create_for_issue("MT-1")

    await manager.run_after_run(workspace.path)

    assert "x" * 500 in caplog.text
    assert "x" * 501 not in caplog.text


@pytest.mark.asyncio
async def test_nonfatal_before_remove_hook_timeout_is_logged_and_cleanup_continues(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path),
        HooksConfig(before_remove="sleep 1", timeout_ms=1),
    )
    workspace = await manager.create_for_issue("MT-1")

    await manager.remove_for_issue("MT-1")

    assert not workspace.path.exists()
    assert "symphony_hook outcome=timeout hook=before_remove" in caplog.text
