from __future__ import annotations

import pytest

from conductor.conductor_runtime_config import sanitize_codex_config_template


def test_codex_config_template_sanitizer_preserves_only_runtime_seed_settings() -> None:
    source = """
# retained heading
model_provider = "custom"
model = "gpt-5.5"
api_key = "sk-private-test-value"


[model_providers.custom]
name = "custom"
env_key = "$CUSTOM_API_KEY"

[model_providers.custom.http_headers]
Authorization = "$CUSTOM_AUTH_HEADER"

[sandbox_workspace_write]
network_access = true

[projects."/private/repository"]
trust_level = "trusted"
secret = "must-disappear"

[mcp_servers.browser.env]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
TOKEN = "must-disappear"

[plugins."browser@openai-bundled"]
enabled = true
"""

    sanitized = sanitize_codex_config_template(source)

    assert sanitized == """# retained heading
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
name = "custom"
env_key = "$CUSTOM_API_KEY"

[model_providers.custom.http_headers]
Authorization = "$CUSTOM_AUTH_HEADER"

[sandbox_workspace_write]
network_access = true
"""
    assert "sk-private-test-value" not in sanitized
    assert "must-disappear" not in sanitized
    assert "BROWSER_USE_AVAILABLE_BACKENDS" not in sanitized


def test_codex_config_template_sanitizer_returns_empty_text_for_empty_or_disallowed_input() -> None:
    assert sanitize_codex_config_template("") == ""
    assert sanitize_codex_config_template('notify = ["/Applications/Codex.app"]\n') == ""


def test_codex_config_template_sanitizer_preserves_non_text_error_without_secret_leak() -> None:
    literal_secret = b"sk-private-test-value"

    with pytest.raises(TypeError) as error:
        sanitize_codex_config_template(literal_secret)  # type: ignore[arg-type]

    assert literal_secret.decode() not in str(error.value)
    assert str(error.value) == "startswith first arg must be bytes or a tuple of bytes, not str"
