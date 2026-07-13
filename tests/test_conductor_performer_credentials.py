from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from conductor.performer_credentials import PerformerCredentialError, PerformerCredentialSlots


CONFIG = 'model = "gpt-5.4"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "file"\n'


def _successful_codex_run(command, **_kwargs):
    output = Path(command[command.index("--output-last-message") + 1])
    output.write_text('{"ok":true}', encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout="", stderr="")


def _initialized(tmp_path: Path) -> PerformerCredentialSlots:
    slots = PerformerCredentialSlots(tmp_path)
    result = slots.init("codex-main", "Main Codex account")
    home = Path(result["codex_home"])
    (home / "auth.json").write_text('{"opaque":"bytes"}', encoding="utf-8")
    return slots


def test_slot_init_is_local_opaque_and_needs_login(tmp_path: Path) -> None:
    slots = PerformerCredentialSlots(tmp_path)
    result = slots.init("codex-main", "Main Codex account")

    assert result["state"] == "needs_login"
    home = Path(result["codex_home"])
    assert (home / "config.toml").read_text() == 'cli_auth_credentials_store = "file"\n'
    assert "auth_method" not in json.dumps(slots.list())


def test_slot_selection_requires_successful_live_check(tmp_path: Path) -> None:
    slots = _initialized(tmp_path)
    with pytest.raises(PerformerCredentialError, match="not_active"):
        slots.select("codex-main")


def test_e2e_seed_staging_uses_same_opaque_slot_service(tmp_path: Path) -> None:
    slots = PerformerCredentialSlots(tmp_path / "data")
    slots.init("codex-main", "Main Codex account")
    seed = tmp_path / "approved-seed"
    seed.mkdir()
    (seed / "auth.json").write_text('{"opaque":true}', encoding="utf-8")
    (seed / "config.toml").write_text('model = "ignored"\n', encoding="utf-8")

    slots.stage_seed("codex-main", seed)

    home = tmp_path / "data" / "performer-credentials" / "codex-main" / "CODEX_HOME"
    assert (home / "auth.json").read_text() == '{"opaque":true}'
    assert (home / "config.toml").read_text() == 'cli_auth_credentials_store = "file"\n'


def test_live_check_activates_slot_and_selection_is_generation_fenced(tmp_path: Path, monkeypatch) -> None:
    slots = _initialized(tmp_path)
    monkeypatch.setattr("conductor.performer_credentials.subprocess.run", _successful_codex_run)

    assert slots.check("codex-main", CONFIG, model="gpt-5.4")["status"] == "passed"
    assert slots.select("codex-main") == {"slot_id": "codex-main", "generation": 1}
    assert slots.select("codex-main") == {"slot_id": "codex-main", "generation": 2}


def test_attempt_materialization_uses_runtime_profile_and_copies_refresh_back(tmp_path: Path, monkeypatch) -> None:
    slots = _initialized(tmp_path)
    monkeypatch.setattr("conductor.performer_credentials.subprocess.run", _successful_codex_run)
    slots.check("codex-main", CONFIG)
    slots.select("codex-main")

    attempt = slots.materialize("codex-main", tmp_path / "attempt", CONFIG)
    assert (attempt.codex_home / "config.toml").read_text() == CONFIG
    assert "opaque" in (attempt.codex_home / "auth.json").read_text()
    (attempt.codex_home / "auth.json").write_text('{"refreshed":true}', encoding="utf-8")
    slots.reconcile(attempt)

    source = tmp_path / "performer-credentials" / "codex-main" / "CODEX_HOME" / "auth.json"
    assert source.read_text() == '{"refreshed":true}'
    assert source.stat().st_mode & 0o777 == 0o600


def test_invalid_refresh_blocks_slot_without_overwriting_source(tmp_path: Path, monkeypatch) -> None:
    slots = _initialized(tmp_path)
    monkeypatch.setattr("conductor.performer_credentials.subprocess.run", _successful_codex_run)
    slots.check("codex-main", CONFIG)
    attempt = slots.materialize("codex-main", tmp_path / "attempt", CONFIG)
    (attempt.codex_home / "auth.json").write_text("", encoding="utf-8")

    with pytest.raises(PerformerCredentialError, match="refresh_commit_failed"):
        slots.reconcile(attempt)

    source = tmp_path / "performer-credentials" / "codex-main" / "CODEX_HOME" / "auth.json"
    assert "opaque" in source.read_text()
    assert slots.list()["slots"][0]["state"] == "blocked"


def test_live_check_classifies_provider_failure_without_exposing_output(tmp_path: Path, monkeypatch) -> None:
    slots = _initialized(tmp_path)
    monkeypatch.setattr(
        "conductor.performer_credentials.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="", stderr="upstream returned HTTP 502 bearer secret-value"),
    )

    with pytest.raises(PerformerCredentialError) as error:
        slots.check("codex-main", CONFIG)

    assert error.value.code == "managed_codex_provider_unavailable"
    assert "secret-value" not in error.value.reason
