from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_pipeline import prepare_mode_environment
from performer.agent_backend import BackendCapability, CodexRuntimeBackend, ModeRequirement
from performer_api.pipeline import RuntimeMode, RuntimeProfile


def test_codex_backend_is_eligible_for_all_three_modes_with_required_capabilities() -> None:
    backend = CodexRuntimeBackend()

    assert backend.is_eligible(RuntimeMode.PLAN)
    assert backend.is_eligible(RuntimeMode.EXECUTE)
    assert backend.is_eligible(RuntimeMode.VERIFY)
    assert ModeRequirement.for_mode(RuntimeMode.PLAN).requires_structured_output is True
    assert ModeRequirement.for_mode(RuntimeMode.EXECUTE).can_write_patch is True
    assert ModeRequirement.for_mode(RuntimeMode.VERIFY).can_write_patch is False
    assert BackendCapability.SHELL in backend.capabilities


def test_prepare_mode_environment_materializes_isolated_codex_home(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="verifier", backend="codex", mode=RuntimeMode.VERIFY, settings={"model": "gpt-5.3-codex"})

    env = prepare_mode_environment(tmp_path, profile)

    assert env["CODEX_HOME"] == str(tmp_path / "runtime-homes" / "verify" / "codex")
    assert Path(env["CODEX_HOME"]).is_dir()


def test_prepare_mode_environment_supports_local_verifier_without_codex_settings(tmp_path: Path) -> None:
    profile = RuntimeProfile(
        name="deterministic-verifier",
        backend="local-verifier",
        mode=RuntimeMode.VERIFY,
        settings={"model": "ignored-for-local-verifier", "sdk_codex_bin": "/bin/codex"},
    )

    env = prepare_mode_environment(tmp_path, profile)

    assert env == {"SYMPHONY_LOCAL_VERIFIER_HOME": str(tmp_path / "runtime-homes" / "verify" / "local-verifier")}
    assert Path(env["SYMPHONY_LOCAL_VERIFIER_HOME"]).is_dir()


def test_prepare_mode_environment_rejects_local_verifier_for_plan_and_execute(tmp_path: Path) -> None:
    for mode in (RuntimeMode.PLAN, RuntimeMode.EXECUTE):
        profile = RuntimeProfile(name=f"{mode.value}-local", backend="local-verifier", mode=mode)

        with pytest.raises(ValueError, match=f"unsupported runtime backend for {mode.value}: local-verifier"):
            prepare_mode_environment(tmp_path, profile)


def test_prepare_mode_environment_rejects_unknown_backend_with_actionable_category(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="planner", backend="mystery", mode=RuntimeMode.PLAN)

    with pytest.raises(ValueError, match="unsupported runtime backend for plan: mystery"):
        prepare_mode_environment(tmp_path, profile)


def test_managed_mode_fails_closed_without_mode_profile(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="runtime profile"):
        prepare_mode_environment(tmp_path, None)


def test_managed_mode_fails_closed_when_isolated_codex_home_cannot_be_materialized(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)
    blocked_home = tmp_path / "runtime-homes" / "plan" / "codex"
    blocked_home.parent.mkdir(parents=True)
    blocked_home.write_text("not a directory", encoding="utf-8")

    with pytest.raises(ValueError, match="isolated CODEX_HOME"):
        prepare_mode_environment(tmp_path, profile)
