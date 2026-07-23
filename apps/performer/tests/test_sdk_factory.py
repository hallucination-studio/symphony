from __future__ import annotations

from unittest.mock import patch

import pytest

from performer.backends.codex.codex_backend_impl import create_sdk
from openai_codex import Sandbox


def test_configured_base_url_uses_public_codex_config() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({"SYMPHONY_CODEX_BASE_URL": "http://codex.example.test/v1"})

    config = codex.call_args.args[0]
    assert config.config_overrides == (
        "features.plugins=false",
        'openai_base_url="http://codex.example.test/v1"',
    )


def test_absent_base_url_uses_sdk_default() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({})

    config = codex.call_args.args[0]
    assert config.config_overrides == ("features.plugins=false",)


def test_sdk_disables_remote_plugin_bootstrap_for_isolated_provider_runtime() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({"SYMPHONY_CODEX_BASE_URL": "http://codex.example.test/v1"})

    config = codex.call_args.args[0]
    assert "features.plugins=false" in config.config_overrides


@pytest.mark.parametrize(
    "value",
    [
        "https://user:secret@codex.example.test/v1",
        "https://codex.example.test/v1?secret=value",
        "https://codex.example.test/v1#secret",
        "https://codex.example.test/v1\ninvalid",
        "ftp://codex.example.test/v1",
    ],
)
def test_unsafe_base_url_is_rejected_before_sdk_start(value: str) -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        with pytest.raises(ValueError, match="codex_base_url_invalid"):
            create_sdk({"SYMPHONY_CODEX_BASE_URL": value})

    codex.assert_not_called()


def test_http_with_an_explicit_port_is_available() -> None:
    with patch("performer.backends.codex.codex_backend_impl.Codex") as codex:
        create_sdk({"SYMPHONY_CODEX_BASE_URL": "http://localhost:8080/v1"})

    assert codex.call_args.args[0].config_overrides == (
        "features.plugins=false",
        'openai_base_url="http://localhost:8080/v1"',
    )


def test_pinned_sdk_exposes_all_product_sandbox_presets() -> None:
    assert Sandbox.read_only.value == "read-only"
    assert Sandbox.workspace_write.value == "workspace-write"
    assert Sandbox.full_access.value == "full-access"
