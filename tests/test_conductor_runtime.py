from __future__ import annotations

import pytest

from conductor.runtime import PerformerRuntime, StaleRuntimeResult
from performer_api.turns import TurnContext


def test_runtime_stages_only_approved_codex_seed_files(tmp_path) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "config.toml").write_text("model = 'test'", encoding="utf-8")
    (seed / "auth.json").write_text("{}", encoding="utf-8")
    (seed / "secret.txt").write_text("do not copy", encoding="utf-8")

    home = PerformerRuntime().stage_codex_home(seed, tmp_path / "run")

    assert (home / "config.toml").exists()
    assert (home / "auth.json").exists()
    assert not (home / "secret.txt").exists()


def test_runtime_rejects_stale_fenced_result() -> None:
    expected = TurnContext("run-1", "task-1", "attempt-1", 3, "execute")
    stale = {"context": {**expected.to_dict(), "fencing_token": 2}}

    with pytest.raises(StaleRuntimeResult, match="stale_fencing_token"):
        PerformerRuntime.accept_result(expected, stale)
