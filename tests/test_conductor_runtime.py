from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

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


def test_runtime_materializes_managed_profile_config_and_selected_credential_slot(tmp_path) -> None:
    state = tmp_path / "state"
    slot = state / "performer-credentials" / "credential-1" / "CODEX_HOME"
    slot.mkdir(parents=True)
    (slot / "auth.json").write_text("{}", encoding="utf-8")
    (slot / "config.toml").write_text("model = 'wrong'\n", encoding="utf-8")

    environment = PerformerRuntime().prepare_environment(
        state,
        workspace_path=tmp_path,
        home_scope="attempt-1",
        codex_config_document='model = "managed"\napproval_policy = "never"\n',
        credential_id="credential-1",
        credential_ref="slot:credential-1",
    )
    home = Path(environment["CODEX_HOME"])

    assert (home / "auth.json").exists()
    managed_config = (home / "config.toml").read_text(encoding="utf-8")
    assert managed_config.startswith('model = "managed"\napproval_policy = "never"\n')
    assert "wrong" not in managed_config


def test_runtime_fails_closed_when_selected_credential_slot_is_missing(tmp_path) -> None:
    with pytest.raises(ValueError, match="managed_codex_credential_slot_required"):
        PerformerRuntime().prepare_environment(
            tmp_path / "state",
            codex_config_document='model = "managed"\n',
            credential_id="credential-1",
            credential_ref="slot:credential-1",
        )


def test_runtime_provisions_selected_slot_only_from_explicit_staged_seed(tmp_path, monkeypatch) -> None:
    seed = tmp_path / "staged-seed"
    seed.mkdir()
    (seed / "auth.json").write_text("{}", encoding="utf-8")
    (seed / "config.toml").write_text("model = 'seed'\n", encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SEED", str(seed))

    environment = PerformerRuntime().prepare_environment(
        tmp_path / "state",
        codex_config_document='model = "managed"\n',
        credential_id="credential-1",
        credential_ref="slot:credential-1",
    )

    slot = tmp_path / "state" / "performer-credentials" / "credential-1" / "CODEX_HOME"
    assert (slot / "auth.json").exists()
    assert (Path(environment["CODEX_HOME"]) / "config.toml").read_text(encoding="utf-8").startswith('model = "managed"')


def test_runtime_rejects_stale_fenced_result() -> None:
    expected = TurnContext("run-1", "task-1", "attempt-1", 3, "execute")
    stale = {"context": {**expected.to_dict(), "fencing_token": 2}}

    with pytest.raises(StaleRuntimeResult, match="stale_fencing_token"):
        PerformerRuntime.accept_result(expected, stale)


def test_runtime_writes_sanitized_instance_log_events(tmp_path) -> None:
    runtime = PerformerRuntime()
    log_path = tmp_path / "conductor.log"

    runtime.append_event(log_path, "event=performer_turn_started token=secret-value")
    runtime.append_event(log_path, "event=performer_turn_completed authorization: Bearer secret-value")

    logs = runtime.read_log(log_path, tail=1, order="desc")
    assert logs["lines"] == ["event=performer_turn_completed authorization: [REDACTED]"]
    assert "secret-value" not in logs["logs"]


def test_runtime_sanitizes_performer_stdout_and_stderr_before_persisting(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime()
    paths = runtime.paths(tmp_path / "attempt")

    def fake_run(*_args, **_kwargs):
        paths.result.write_text("{}", encoding="utf-8")
        return SimpleNamespace(
            returncode=0,
            stdout="Authorization: Bearer stdout-secret\n",
            stderr="token=stderr-secret\n",
        )

    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    runtime.run(paths, codex_home=tmp_path / "codex")

    log_text = paths.log.read_text(encoding="utf-8")
    assert "stdout-secret" not in log_text
    assert "stderr-secret" not in log_text
    assert "Authorization: [REDACTED]" in log_text
    assert "token=[REDACTED]" in log_text


def test_runtime_preserves_sanitized_performer_failure_reason(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime()
    paths = runtime.paths(tmp_path / "attempt")

    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            returncode=1,
            stdout="performer startup failed: upstream_overloaded_exhausted:http_status=502 token=secret-value\n",
            stderr="",
        )

    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    with pytest.raises(RuntimeError, match=r"performer_failed:exit_1:upstream_overloaded_exhausted:http_status=502 token=\[REDACTED\]"):
        runtime.run(paths, codex_home=tmp_path / "codex")
