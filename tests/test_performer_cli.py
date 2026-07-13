from __future__ import annotations

from performer import cli
from performer.codex_client_helpers import CodexError


def test_cli_persists_codex_error_code_in_startup_failure(monkeypatch, capsys) -> None:
    def fail(_awaitable):
        close = getattr(_awaitable, "close", None)
        if callable(close):
            close()
        raise CodexError("codex_auth_failed", "Codex authentication failed")

    monkeypatch.setattr(cli.asyncio, "run", fail)

    assert cli.main(["--turn-request-path", "/tmp/request.json", "--turn-result-path", "/tmp/result.json"]) == 1
    assert "performer startup failed: codex_auth_failed:Codex authentication failed" in capsys.readouterr().out
