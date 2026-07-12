from __future__ import annotations

from pathlib import Path

import pytest

from conductor.runtime import PerformerRuntime, StaleRuntimeResult
from performer_api.turns import TurnContext


def test_runtime_prepares_an_isolated_home_from_approved_seed_files(tmp_path, monkeypatch) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "config.toml").write_text("model = 'test'\nsecret_setting = 'do not copy'", encoding="utf-8")
    (seed / "auth.json").write_text("{}", encoding="utf-8")
    (seed / "secret.txt").write_text("do not copy", encoding="utf-8")

    monkeypatch.setenv("CODEX_HOME_SOURCE", str(seed))

    environment = PerformerRuntime().prepare_environment(
        tmp_path / "state",
        workspace_path=tmp_path,
        home_scope="attempt-1",
    )
    home = Path(environment["CODEX_HOME"])

    assert (home / "config.toml").exists()
    assert (home / "auth.json").exists()
    assert not (home / "secret.txt").exists()
    config = (home / "config.toml").read_text(encoding="utf-8")
    assert "model = 'test'" in config
    assert "secret_setting" not in config


def test_runtime_rejects_stale_fenced_result() -> None:
    expected = TurnContext("run-1", "task-1", "attempt-1", 3, "execute")
    stale = {"context": {**expected.to_dict(), "fencing_token": 2}}

    with pytest.raises(StaleRuntimeResult, match="stale_fencing_token"):
        PerformerRuntime.accept_result(expected, stale)
