from __future__ import annotations

from types import SimpleNamespace

import pytest

from conductor.conductor_podium_sync import (
    ConductorPodiumSyncMixin,
    _profile_from_command,
    _validate_project_configure_command,
)
from performer_api.runtime_policy import PerformerProfileConfig, RuntimePolicyError


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


def _profile(*, reasoning_effort: str = "high") -> PerformerProfileConfig:
    return PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=7,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        execution_policy={**EXECUTION_POLICY, "reasoning_effort": reasoning_effort},
        turn_policy={"max_turns": 4},
    )


def _instance(profile: PerformerProfileConfig) -> SimpleNamespace:
    return SimpleNamespace(
        id="instance-1",
        name="Project",
        linear_project="PROJ",
        repo_source_type="local_path",
        repo_source_value="/repo",
        linear_filters={
            "binding_id": "binding-1",
            "binding_config_version": 7,
            "linear_project_id": "project-1",
            "performer_binding_generation": 3,
            "execution_policy_sha256": profile.execution_policy_sha256,
            "turn_policy_sha256": profile.turn_policy_sha256,
        },
    )


class _Service:
    def update_instance(self, *_args: object, **_kwargs: object) -> None:
        raise AssertionError("stale or drifting policy must not update the instance")


def _command(profile: PerformerProfileConfig) -> dict[str, object]:
    return {
        "type": "project.configure",
        **profile.to_dict(),
        "config_version": 7,
        "performer_binding_generation": 3,
        "linear_project_id": "project-1",
        "project_slug": "PROJ",
        "project_name": "Project",
        "agent_app_user_id": "agent-1",
        "repository": {"mode": "local_path", "value": "/repo"},
    }


def test_project_configure_rejects_unknown_envelope_and_repository_fields() -> None:
    command = _command(_profile())

    for payload in (
        {**command, "api_key": "opaque-secret"},
        {**command, "repository": {"mode": "local_path", "value": "/repo", "token": "opaque"}},
    ):
        with pytest.raises(RuntimePolicyError) as error:
            _validate_project_configure_command(payload)

        assert error.value.code == "project_config_key_rejected"
        assert "api_key" not in error.value.reason
        assert "token" not in error.value.reason


def test_project_configure_extracts_only_the_closed_profile_envelope() -> None:
    profile = _profile()

    assert _profile_from_command(_command(profile), 7) == profile


@pytest.mark.parametrize("generation", [None, 0, -1, False])
def test_project_configure_requires_positive_performer_binding_generation(
    generation: object,
) -> None:
    command = _command(_profile())
    if generation is None:
        command.pop("performer_binding_generation")
    else:
        command["performer_binding_generation"] = generation

    with pytest.raises(RuntimePolicyError) as error:
        _validate_project_configure_command(command)

    assert error.value.code == "invalid_performer_binding_generation"


def test_project_configure_rejects_stale_performer_binding_generation() -> None:
    profile = _profile()

    result = ConductorPodiumSyncMixin._update_project_instance(
        _Service(),
        _instance(profile),
        {"binding_id": "binding-1", "performer_binding_generation": 2},
        "project-1",
        7,
        "local_path",
        "/repo",
        profile,
    )

    assert result == {
        "status": "rejected",
        "reason": "stale_performer_binding_generation",
        "current_generation": 3,
    }


def test_project_configure_rejects_same_generation_policy_hash_drift() -> None:
    current = _profile()
    changed = _profile(reasoning_effort="xhigh")

    result = ConductorPodiumSyncMixin._update_project_instance(
        _Service(),
        _instance(current),
        {"binding_id": "binding-1", "performer_binding_generation": 3},
        "project-1",
        7,
        "local_path",
        "/repo",
        changed,
    )

    assert result == {"status": "rejected", "reason": "performer_binding_hash_mismatch"}
