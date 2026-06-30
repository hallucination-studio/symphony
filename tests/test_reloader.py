from __future__ import annotations

from pathlib import Path

import pytest

from symphony.reloader import WorkflowReloader


def write_workflow(path: Path, interval: int) -> None:
    path.write_text(
        f"""---
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
polling:
  interval_ms: {interval}
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )


def test_reloader_keeps_last_good_config_after_invalid_reload(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "WORKFLOW.md"
    write_workflow(path, 1000)
    reloader = WorkflowReloader(path)
    first = reloader.current()
    path.write_text("---\ntracker: [", encoding="utf-8")

    second = reloader.current()

    assert second is first
    assert reloader.last_error is not None
    assert "symphony_workflow_reload failed" in caplog.text


def test_reloader_applies_changed_workflow(tmp_path: Path) -> None:
    path = tmp_path / "WORKFLOW.md"
    write_workflow(path, 1000)
    reloader = WorkflowReloader(path)
    assert reloader.current().polling.interval_ms == 1000
    write_workflow(path, 2000)

    assert reloader.current().polling.interval_ms == 2000


def test_reloader_loads_env_file_next_to_workflow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    (tmp_path / ".env").write_text("LINEAR_API_KEY=linear-token-from-file\n", encoding="utf-8")
    path = tmp_path / "WORKFLOW.md"
    path.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: $LINEAR_API_KEY
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )

    config = WorkflowReloader(path).current()

    assert config.tracker.api_key == "linear-token-from-file"
