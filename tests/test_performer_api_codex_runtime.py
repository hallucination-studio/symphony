from __future__ import annotations

import hashlib
import json

import pytest

from performer_api.codex_runtime import (
    PerformerProfileConfig,
    RuntimePolicy,
    RuntimePolicyError,
)


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


def _canonical_hash(value: dict[str, object]) -> str:
    document = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(document.encode("utf-8")).hexdigest()


def _profile(**overrides: object) -> PerformerProfileConfig:
    values: dict[str, object] = {
        "binding_id": "binding-1",
        "binding_config_version": 4,
        "performer_binding_id": "performer-binding-1",
        "performer_profile_id": "performer-profile-1",
        "runtime_profile_id": "runtime-profile-1",
        "performer_kind": "codex",
        "runtime_kind": "codex",
        "execution_policy": EXECUTION_POLICY,
        "turn_policy": {"max_turns": 4, "approval": "on-request"},
    }
    values.update(overrides)
    return PerformerProfileConfig.create(**values)  # type: ignore[arg-type]


def test_runtime_policy_accepts_canonical_real_e2e_fixture_and_round_trips() -> None:
    policy = RuntimePolicy.from_dict(EXECUTION_POLICY)

    assert policy.to_dict() == EXECUTION_POLICY
    assert RuntimePolicy.from_dict(policy.to_dict()) == policy


def test_performer_profile_config_hashes_both_policies_and_hides_documents_from_summary() -> None:
    config = _profile()

    assert config.execution_policy_sha256 == _canonical_hash(EXECUTION_POLICY)
    assert config.turn_policy_sha256 == _canonical_hash(
        {"max_turns": 4, "approval": "on-request"}
    )
    assert config.public_summary() == {
        "binding_id": "binding-1",
        "binding_config_version": 4,
        "performer_binding_id": "performer-binding-1",
        "performer_profile_id": "performer-profile-1",
        "runtime_profile_id": "runtime-profile-1",
        "performer_kind": "codex",
        "runtime_kind": "codex",
        "execution_policy_sha256": config.execution_policy_sha256,
        "turn_policy_sha256": config.turn_policy_sha256,
    }
    assert PerformerProfileConfig.from_dict(config.to_dict()) == config


def test_one_policy_mutation_changes_only_its_relevant_hash() -> None:
    original = _profile()
    execution_changed = _profile(
        execution_policy={**EXECUTION_POLICY, "reasoning_effort": "xhigh"}
    )
    turn_changed = _profile(turn_policy={"max_turns": 5, "approval": "on-request"})

    assert execution_changed.execution_policy_sha256 != original.execution_policy_sha256
    assert execution_changed.turn_policy_sha256 == original.turn_policy_sha256
    assert turn_changed.execution_policy_sha256 == original.execution_policy_sha256
    assert turn_changed.turn_policy_sha256 != original.turn_policy_sha256


@pytest.mark.parametrize(
    "field",
    [
        "config_format",
        "config_document",
        "config_sha256",
        "credential_id",
        "credential_ref",
        "slot_id",
        "api_host",
        "codex_home",
        "codex_endpoint",
    ],
)
def test_runtime_policy_rejects_every_codex_owned_field(field: str) -> None:
    with pytest.raises(RuntimePolicyError, match=field):
        RuntimePolicy.from_dict({**EXECUTION_POLICY, field: "forbidden"})


def test_runtime_policy_rejects_unknown_keys() -> None:
    with pytest.raises(RuntimePolicyError) as error:
        RuntimePolicy.from_dict({**EXECUTION_POLICY, "unexpected": True})

    assert error.value.code == "runtime_policy_key_rejected"
    assert "unexpected" not in error.value.reason


@pytest.mark.parametrize("field", ["model", "model_provider"])
def test_runtime_policy_rejects_secret_shaped_identifiers(field: str) -> None:
    with pytest.raises(RuntimePolicyError, match=field):
        RuntimePolicy.from_dict(
            {**EXECUTION_POLICY, field: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("version", 2),
        ("model", ""),
        ("model", "m" * 201),
        ("model_provider", ""),
        ("model_provider", "p" * 201),
        ("approval_mode", "on_request"),
        ("reasoning_effort", "ultra"),
        ("reasoning_summary", "verbose"),
        ("initialize_timeout_ms", 0),
        ("turn_timeout_ms", -1),
        ("initialize_max_attempts", False),
        ("overload_max_attempts", 0),
    ],
)
def test_runtime_policy_rejects_invalid_enums_and_bounds(field: str, value: object) -> None:
    with pytest.raises(RuntimePolicyError, match=field):
        RuntimePolicy.from_dict({**EXECUTION_POLICY, field: value})


@pytest.mark.parametrize("approval_mode", ["deny_all", "auto_review"])
@pytest.mark.parametrize(
    "reasoning_effort", ["none", "minimal", "low", "medium", "high", "xhigh"]
)
@pytest.mark.parametrize("reasoning_summary", ["none", "auto", "concise", "detailed"])
def test_runtime_policy_accepts_all_approved_enum_values(
    approval_mode: str,
    reasoning_effort: str,
    reasoning_summary: str,
) -> None:
    policy = RuntimePolicy.from_dict(
        {
            **EXECUTION_POLICY,
            "approval_mode": approval_mode,
            "reasoning_effort": reasoning_effort,
            "reasoning_summary": reasoning_summary,
        }
    )

    assert policy.approval_mode == approval_mode
    assert policy.reasoning_effort == reasoning_effort
    assert policy.reasoning_summary == reasoning_summary


@pytest.mark.parametrize(
    "sandbox",
    [
        {"plan": "workspace_write", "execute": "workspace_write", "gate": "read_only"},
        {"plan": "read_only", "execute": "read_only", "gate": "read_only"},
        {"plan": "read_only", "execute": "workspace_write", "gate": "workspace_write"},
        {"plan": "read_only", "execute": "workspace_write"},
        {
            "plan": "read_only",
            "execute": "workspace_write",
            "gate": "read_only",
            "unexpected": "read_only",
        },
    ],
)
def test_runtime_policy_requires_the_fixed_sandbox_map(sandbox: dict[str, str]) -> None:
    with pytest.raises(RuntimePolicyError, match="sandbox"):
        RuntimePolicy.from_dict({**EXECUTION_POLICY, "sandbox": sandbox})


def test_performer_profile_rejects_oversized_nested_turn_policy() -> None:
    with pytest.raises(RuntimePolicyError, match="turn_policy.*large"):
        _profile(turn_policy={"nested": {"value": "x" * (32 * 1024)}})


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_performer_profile_rejects_non_finite_turn_policy_numbers(value: float) -> None:
    with pytest.raises(RuntimePolicyError, match="turn_policy"):
        _profile(turn_policy={"budget": value})


@pytest.mark.parametrize(
    "turn_policy",
    [
        {"token": "opaque-secret"},
        {"apiKey": "opaque-secret"},
        {"accessToken": "opaque-secret"},
        {"privateKey": "opaque-secret"},
        {"x-api-key": "opaque-secret"},
        {"session_token": "opaque-secret"},
        {"proxy_token": "opaque-secret"},
        {"openai_api_key": "opaque-secret"},
        {"github_token": "opaque-secret"},
        {"client_password": "opaque-secret"},
        {"my_credential_ref": "opaque-secret"},
        {"secret_value": "opaque-secret"},
        {"password_hash": "opaque-secret"},
        {"token_source": "opaque-secret"},
        {"credential_name": "opaque-secret"},
        {"authorization_header": "opaque-secret"},
        {"api_key_name": "opaque-secret"},
        {"private_key": "-----BEGIN PRIVATE KEY-----\nsecret"},
        {"headers": {"x-auth-token": "opaque-secret"}},
        {"endpoint": "https://user:password@example.com/api"},
        {"assertion": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue"},
    ],
)
def test_performer_profile_rejects_secret_bearing_turn_policy(
    turn_policy: dict[str, object],
) -> None:
    with pytest.raises(RuntimePolicyError, match="turn_policy"):
        _profile(turn_policy=turn_policy)


def test_performer_profile_allows_non_secret_token_count_fields() -> None:
    config = _profile(turn_policy={"max_tokens": 4096})

    assert config.turn_policy == {"max_tokens": 4096}


def test_performer_profile_rejects_secret_literals_in_keys_without_echoing_them() -> None:
    secret_key = "field-sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    with pytest.raises(RuntimePolicyError) as error:
        _profile(turn_policy={secret_key: "safe-value"})

    assert error.value.code == "runtime_policy_field_rejected"
    assert secret_key not in error.value.reason


def test_performer_profile_rejects_excessive_policy_depth_and_nodes() -> None:
    nested: dict[str, object] = {}
    cursor = nested
    for _ in range(40):
        child: dict[str, object] = {}
        cursor["next"] = child
        cursor = child

    with pytest.raises(RuntimePolicyError, match="turn_policy"):
        _profile(turn_policy=nested)
    with pytest.raises(RuntimePolicyError, match="turn_policy"):
        _profile(turn_policy={"items": list(range(1_025))})


def test_performer_profile_rejects_mismatched_hashes() -> None:
    config = _profile()

    with pytest.raises(RuntimePolicyError, match="execution policy hash"):
        PerformerProfileConfig.from_dict(
            {**config.to_dict(), "execution_policy_sha256": "0" * 64}
        )
    with pytest.raises(RuntimePolicyError, match="turn policy hash"):
        PerformerProfileConfig.from_dict(
            {**config.to_dict(), "turn_policy_sha256": "0" * 64}
        )


@pytest.mark.parametrize(
    "field",
    [
        "runtime_config_version",
        "policy_revision",
        "runtime_profile_revision",
        "runtime_profile_revision_id",
        "performer_profile_revision",
        "performer_profile_revision_id",
    ],
)
def test_performer_profile_config_rejects_profile_revision_fields(field: str) -> None:
    config = _profile()

    with pytest.raises(RuntimePolicyError, match="revision"):
        PerformerProfileConfig.from_dict({**config.to_dict(), field: "legacy-revision"})


def test_performer_profile_config_rejects_unknown_envelope_fields() -> None:
    config = _profile()

    with pytest.raises(RuntimePolicyError) as error:
        PerformerProfileConfig.from_dict({**config.to_dict(), "unexpected": "secret"})

    assert error.value.code == "performer_profile_key_rejected"
    assert "unexpected" not in error.value.reason
