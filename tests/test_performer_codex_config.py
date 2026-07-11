from __future__ import annotations

from dataclasses import FrozenInstanceError, fields

import pytest

from performer.codex_config import CodexConfig


def test_codex_config_exposes_only_sdk_runtime_fields_with_stable_defaults() -> None:
    config = CodexConfig()

    assert [field.name for field in fields(config)] == [
        "model",
        "sdk_codex_bin",
        "sandbox",
        "config_overrides",
        "hard_turn_timeout_ms",
        "read_timeout_ms",
        "init_max_attempts",
        "init_backoff_ms",
        "init_backoff_max_ms",
        "overload_max_attempts",
        "overload_initial_delay_ms",
        "overload_max_delay_ms",
    ]
    assert config == CodexConfig(
        model=None,
        sdk_codex_bin=None,
        sandbox=None,
        config_overrides=(),
        hard_turn_timeout_ms=3_600_000,
        read_timeout_ms=5_000,
        init_max_attempts=4,
        init_backoff_ms=500,
        init_backoff_max_ms=8_000,
        overload_max_attempts=5,
        overload_initial_delay_ms=250,
        overload_max_delay_ms=8_000,
    )


def test_codex_config_is_an_immutable_performer_owned_value() -> None:
    config = CodexConfig(model="gpt-5-codex")

    with pytest.raises(FrozenInstanceError):
        config.model = "other"  # type: ignore[misc]


def test_codex_config_accepts_secret_indirection_without_exposing_overrides_in_repr() -> None:
    config = CodexConfig(
        config_overrides=(
            "model_provider=openai",
            "model_providers.openai.api_key=$OPENAI_API_KEY",
        )
    )

    assert config.config_overrides[-1].endswith("=$OPENAI_API_KEY")
    assert "OPENAI_API_KEY" not in repr(config)


def test_codex_config_rejects_literal_secret_override_without_echoing_it() -> None:
    literal_secret = "sk-private-test-value"

    with pytest.raises(ValueError) as exc_info:
        CodexConfig(
            config_overrides=(
                f"model_providers.openai.api_key={literal_secret}",
            )
        )

    assert literal_secret not in str(exc_info.value)
    assert "must use $VAR indirection" in str(exc_info.value)


@pytest.mark.parametrize(
    "override",
    (
        "api_key=$",
        "api_key=$sk-private-literal",
        "api_key=$VAR tail",
        "api-key=literal-secret",
        "api.key=literal-secret",
    ),
)
def test_codex_config_rejects_invalid_secret_indirection_and_key_separator_bypasses(
    override: str,
) -> None:
    with pytest.raises(ValueError) as exc_info:
        CodexConfig(config_overrides=(override,))

    assert override not in str(exc_info.value)
    assert "must use $VAR indirection" in str(exc_info.value)
