from __future__ import annotations

from typing import Any

import pytest

from podium import cli


@pytest.mark.anyio
async def test_api_disables_uvicorn_access_log(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODIUM_DATABASE_URL", "postgresql://podium.test/podium")
    config_kwargs: dict[str, Any] = {}

    class Store:
        async def ensure_schema(self) -> None:
            return None

        async def close(self) -> None:
            return None

    async def connect(_database_url: str) -> Store:
        return Store()

    class Server:
        def __init__(self, _config: object) -> None:
            return None

        async def serve(self) -> None:
            return None

    def uvicorn_config(*_args: Any, **kwargs: Any) -> object:
        config_kwargs.update(kwargs)
        return object()

    monkeypatch.setattr(cli.PgStore, "connect", connect)
    monkeypatch.setattr(cli, "create_app", lambda **_kwargs: object())
    monkeypatch.setattr(cli.uvicorn, "Config", uvicorn_config)
    monkeypatch.setattr(cli.uvicorn, "Server", Server)

    assert await cli.async_main(["api"]) == 0
    assert config_kwargs["access_log"] is False
