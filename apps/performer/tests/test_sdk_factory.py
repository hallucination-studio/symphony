from __future__ import annotations

from unittest.mock import patch

import pytest

from performer.backends.codex.codex_backend_impl import create_sdk


def test_configured_base_url_uses_public_codex_config() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({"SYMPHONY_CODEX_BASE_URL": "https://codex.example.test/v1"})

    config = codex.call_args.args[0]
    assert config.config_overrides == (
        'openai_base_url="https://codex.example.test/v1"',
    )


def test_absent_base_url_uses_sdk_default() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({})

    codex.assert_called_once_with()


@pytest.mark.parametrize(
    "value",
    [
        "http://codex.example.test/v1",
        "https://user:secret@codex.example.test/v1",
        "https://codex.example.test/v1?secret=value",
        "https://codex.example.test/v1#secret",
        "https://codex.example.test/v1\ninvalid",
    ],
)
def test_unsafe_base_url_is_rejected_before_sdk_start(value: str) -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        with pytest.raises(ValueError, match="codex_base_url_invalid"):
            create_sdk({"SYMPHONY_CODEX_BASE_URL": value})

    codex.assert_not_called()


def test_loopback_http_is_available_for_local_e2e() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({"SYMPHONY_CODEX_BASE_URL": "http://localhost:8080/v1"})

    assert codex.call_args.args[0].config_overrides == (
        'openai_base_url="http://localhost:8080/v1"',
    )
