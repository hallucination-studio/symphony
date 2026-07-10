from __future__ import annotations

from pathlib import Path

import pytest

from conductor.runtime_backends import prepare_backend_environment
from performer.agent_backend import BackendCapability, CodexRuntimeBackend, RoleRequirement
from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeProfile


def test_codex_backend_is_eligible_for_managed_run_roles_with_required_capabilities() -> None:
    backend = CodexRuntimeBackend()

    assert backend.is_eligible(ManagedRunRuntimeRole.PLAN)
    assert backend.is_eligible(ManagedRunRuntimeRole.WORK_ITEM)
    assert backend.is_eligible(ManagedRunRuntimeRole.VERIFY)
    assert RoleRequirement.for_role(ManagedRunRuntimeRole.PLAN).requires_structured_output is True
    assert RoleRequirement.for_role(ManagedRunRuntimeRole.WORK_ITEM).can_write_patch is True
    assert RoleRequirement.for_role(ManagedRunRuntimeRole.VERIFY).can_write_patch is False
    assert BackendCapability.SHELL in backend.capabilities


def test_prepare_backend_environment_materializes_isolated_codex_home(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="verifier", backend="codex", role=ManagedRunRuntimeRole.VERIFY, settings={"model": "gpt-5.3-codex"})

    env = prepare_backend_environment(tmp_path, profile)

    assert env["CODEX_HOME"] == str(tmp_path / "runtime-homes" / "verify" / "codex")
    assert Path(env["CODEX_HOME"]).is_dir()


def test_prepare_backend_environment_supports_local_verifier_without_codex_settings(tmp_path: Path) -> None:
    profile = RuntimeProfile(
        name="deterministic-verifier",
        backend="local-verifier",
        role=ManagedRunRuntimeRole.VERIFY,
        settings={"model": "ignored-for-local-verifier", "sdk_codex_bin": "/bin/codex"},
    )

    env = prepare_backend_environment(tmp_path, profile)

    assert env == {"SYMPHONY_LOCAL_VERIFIER_HOME": str(tmp_path / "runtime-homes" / "verify" / "local-verifier")}
    assert Path(env["SYMPHONY_LOCAL_VERIFIER_HOME"]).is_dir()


def test_prepare_backend_environment_passes_local_verifier_replan_failure_probe(tmp_path: Path) -> None:
    profile = RuntimeProfile(
        name="deterministic-verifier",
        backend="local-verifier",
        role=ManagedRunRuntimeRole.VERIFY,
        settings={"force_first_verify_failure_for_replan": True},
    )

    env = prepare_backend_environment(tmp_path, profile)

    assert env["SYMPHONY_LOCAL_VERIFIER_HOME"] == str(tmp_path / "runtime-homes" / "verify" / "local-verifier")
    assert env["SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN"] == "1"
    assert env["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"] == str(tmp_path / "runtime-homes" / "verify" / "local-verifier")


def test_local_verifier_replan_failure_probe_marker_survives_attempt_scoped_homes(tmp_path: Path) -> None:
    profile = RuntimeProfile(
        name="deterministic-verifier",
        backend="local-verifier",
        role=ManagedRunRuntimeRole.VERIFY,
        settings={"force_first_verify_failure_for_replan": True},
    )

    first = prepare_backend_environment(tmp_path, profile, home_scope="verify-turn-1")
    second = prepare_backend_environment(tmp_path, profile, home_scope="verify-turn-2")

    assert first["SYMPHONY_LOCAL_VERIFIER_HOME"] != second["SYMPHONY_LOCAL_VERIFIER_HOME"]
    assert first["SYMPHONY_LOCAL_VERIFIER_HOME"].endswith(
        "/runtime-homes/verify/verify-turn-1/local-verifier"
    )
    assert second["SYMPHONY_LOCAL_VERIFIER_HOME"].endswith(
        "/runtime-homes/verify/verify-turn-2/local-verifier"
    )
    assert first["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"] == second["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"]
    assert first["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"] == str(tmp_path / "runtime-homes" / "verify" / "local-verifier")


def test_prepare_backend_environment_rejects_local_verifier_for_plan_and_work_item(tmp_path: Path) -> None:
    for role in (ManagedRunRuntimeRole.PLAN, ManagedRunRuntimeRole.WORK_ITEM):
        profile = RuntimeProfile(name=f"{role.value}-local", backend="local-verifier", role=role)

        with pytest.raises(ValueError, match=f"unsupported runtime backend for {role.value}: local-verifier"):
            prepare_backend_environment(tmp_path, profile)


def test_prepare_backend_environment_rejects_unknown_backend_with_actionable_category(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="planner", backend="mystery", role=ManagedRunRuntimeRole.PLAN)

    with pytest.raises(ValueError, match="unsupported runtime backend for plan: mystery"):
        prepare_backend_environment(tmp_path, profile)


def test_managed_managed_run_turn_fails_closed_without_profile(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="runtime profile"):
        prepare_backend_environment(tmp_path, None)


def test_managed_managed_run_turn_fails_closed_when_isolated_codex_home_cannot_be_materialized(tmp_path: Path) -> None:
    profile = RuntimeProfile(name="planner", backend="codex", role=ManagedRunRuntimeRole.PLAN)
    blocked_home = tmp_path / "runtime-homes" / "plan" / "codex"
    blocked_home.parent.mkdir(parents=True)
    blocked_home.write_text("not a directory", encoding="utf-8")

    with pytest.raises(ValueError, match="isolated CODEX_HOME"):
        prepare_backend_environment(tmp_path, profile)
