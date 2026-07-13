from __future__ import annotations

import json
from pathlib import Path

from performer import cli
from performer.backend_registry import DEFAULT_BACKEND_REGISTRY
from performer.backends.codex import CodexBackend


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
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


def test_cli_emits_a_closed_sanitized_startup_failure_to_stderr(monkeypatch, capsys) -> None:
    def fail(_awaitable):
        close = getattr(_awaitable, "close", None)
        if callable(close):
            close()
        raise RuntimeError("/private/provider/auth.json private-backend-detail")

    monkeypatch.setattr(cli.asyncio, "run", fail)

    assert cli.main(["--turn-request-path", "/tmp/request.json", "--turn-result-path", "/tmp/result.json"]) == 1
    output = capsys.readouterr()
    record = json.loads(output.err)
    assert record["event"] == "performer_startup_failed"
    assert record["error_code"] == "performer_startup_failed"
    assert "/private/provider/auth.json" not in output.err
    assert "private-backend-detail" not in output.err
    assert output.out == ""


def test_cli_depends_only_on_the_private_backend_registry() -> None:
    source = Path(cli.__file__).read_text(encoding="utf-8")

    assert "CodexBackend" not in source
    assert "backends.codex" not in source
    assert "DEFAULT_BACKEND_REGISTRY" in source
    assert DEFAULT_BACKEND_REGISTRY.create("codex").kind == "codex"


def test_default_registry_owns_the_allowlisted_codex_binary_configuration(monkeypatch) -> None:
    monkeypatch.setenv("CODEX_SDK_CODEX_BIN", "/opt/symphony/codex")

    backend = DEFAULT_BACKEND_REGISTRY.create("codex")

    assert isinstance(backend, CodexBackend)
    assert backend._sdk_codex_bin == "/opt/symphony/codex"
