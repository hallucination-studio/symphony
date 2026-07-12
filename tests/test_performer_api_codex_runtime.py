from __future__ import annotations

import pytest

from performer_api.codex_runtime import CodexRuntimeConfig, CodexRuntimeConfigError, validate_codex_toml


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
        runtime_config_version=3,
        policy_revision=4,
        config_toml=VALID_CONFIG,
    )

    assert config.config_toml.endswith("\n")
    assert len(config.config_sha256) == 64
    assert "config_toml" not in config.public_summary()
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
        runtime_config_version=1,
        policy_revision=1,
        config_toml=VALID_CONFIG,
    )

    with pytest.raises(CodexRuntimeConfigError, match="hash"):
        CodexRuntimeConfig.from_dict({**config.to_dict(), "config_sha256": "0" * 64})
