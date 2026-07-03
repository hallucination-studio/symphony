from pathlib import Path

import httpx
import pytest

from podium.app import create_app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_serves_index_and_spa_fallback(tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>Podium</title>", encoding="utf-8")
    (static / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")

    app = create_app(turnstile_verifier=lambda t, ip: True, secure_cookies=False, static_dir=str(static))
    async with _client(app) as client:
        asset = await client.get("/assets/app.js")
        assert asset.status_code == 200
        assert "javascript" in asset.headers["content-type"]

        spa = await client.get("/setup")
        assert spa.status_code == 200
        assert "<!doctype html>" in spa.text

        missing = await client.get("/api/v1/does-not-exist")
        assert missing.status_code == 404
        assert missing.headers["content-type"].startswith("application/json")


@pytest.mark.asyncio
async def test_health_and_service_root_unaffected_without_static() -> None:
    app = create_app(turnstile_verifier=lambda t, ip: True, secure_cookies=False)
    async with _client(app) as client:
        health = await client.get("/api/v1/health")
        assert health.json() == {"status": "ok"}
        root = await client.get("/")
        assert root.json() == {"service": "Podium"}
