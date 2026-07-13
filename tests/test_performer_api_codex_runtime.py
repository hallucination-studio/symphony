from __future__ import annotations

import pytest

from performer_api.codex_runtime import (
    CodexRuntimeConfig,
    CodexRuntimeConfigError,
    PerformerProfileConfig,
    validate_codex_toml,
)


VALID_CONFIG = """
model_provider = "custom"
model = "gpt-test"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "workspace-write"
cli_auth_credentials_store = "file"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "http://127.0.0.1:8317/v1"
requires_openai_auth = true

[sandbox_workspace_write]
network_access = true
"""


def test_runtime_config_normalizes_hashes_and_hides_content_from_summary() -> None:
    config = CodexRuntimeConfig.create(
        binding_id="binding-1",
        binding_config_version=2,
        runtime_profile_id="runtime-profile-1",
        config_document=VALID_CONFIG,
    )

    assert config.config_document.endswith("\n")
    assert len(config.config_sha256) == 64
    assert "config_document" not in config.public_summary()
    assert "runtime_config_version" not in config.to_dict()
    assert "policy_revision" not in config.to_dict()
    assert CodexRuntimeConfig.from_dict(config.to_dict()) == config


@pytest.mark.parametrize(
    "source,code",
    [
        ("projects = {}\n", "managed_codex_config_key_rejected"),
        ("model_reasoning_effort = \"ultra\"\n", "managed_codex_config_invalid"),
        ("api_key = \"sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\"\n", "managed_codex_secret_rejected"),
        ("[model_providers.custom]\nsecret_header = \"value\"\n", "managed_codex_secret_rejected"),
    ],
)
def test_runtime_config_rejects_unsafe_or_unsupported_toml(source: str, code: str) -> None:
    with pytest.raises(CodexRuntimeConfigError) as error:
        validate_codex_toml(source)
    assert error.value.code == code


def test_runtime_config_requires_matching_hash() -> None:
    config = CodexRuntimeConfig.create(
        binding_id="binding-1",
        binding_config_version=1,
        runtime_profile_id="runtime-profile-1",
        config_document=VALID_CONFIG,
    )

    with pytest.raises(CodexRuntimeConfigError, match="hash"):
        CodexRuntimeConfig.from_dict({**config.to_dict(), "config_sha256": "0" * 64})


def test_performer_profile_config_carries_only_current_non_secret_profiles() -> None:
    config = PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=4,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        turn_policy={"max_turns": 4, "approval": "on-request"},
        config_document=VALID_CONFIG,
    )

    payload = config.to_dict()
    assert payload["binding_config_version"] == 4
    assert payload["config_format"] == "toml"
    assert payload["config_sha256"] == config.config_sha256
    assert payload["policy_sha256"] == config.policy_sha256
    assert config.public_summary() == {
        "binding_id": "binding-1",
        "binding_config_version": 4,
        "performer_binding_id": "performer-binding-1",
        "performer_profile_id": "performer-profile-1",
        "runtime_profile_id": "runtime-profile-1",
        "performer_kind": "codex",
        "runtime_kind": "codex",
        "config_sha256": config.config_sha256,
        "policy_sha256": config.policy_sha256,
    }
    assert PerformerProfileConfig.from_dict(payload) == config


def test_performer_profile_config_rejects_profile_revision_fields() -> None:
    with pytest.raises(CodexRuntimeConfigError, match="revision"):
        PerformerProfileConfig.from_dict(
            {
                "binding_id": "binding-1",
                "binding_config_version": 1,
                "performer_binding_id": "performer-binding-1",
                "performer_profile_id": "performer-profile-1",
                "performer_profile_revision_id": "legacy-revision",
                "runtime_profile_id": "runtime-profile-1",
                "performer_kind": "codex",
                "runtime_kind": "codex",
                "turn_policy": {},
                "config_format": "toml",
                "config_document": VALID_CONFIG,
            }
        )


@pytest.mark.parametrize(
    "source",
    [
        'model = "gpt-test"\n',
        'model = "gpt-test"\ncli_auth_credentials_store = "auto"\n',
        'model = "gpt-test"\ncli_auth_credentials_store = "keyring"\n',
    ],
)
def test_managed_runtime_config_requires_file_credential_store(source: str) -> None:
    with pytest.raises(CodexRuntimeConfigError, match="requires"):
        validate_codex_toml(source)
