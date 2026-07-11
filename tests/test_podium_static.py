from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
import pytest

from podium.app import create_app


class _AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.assets: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.assets.append((values["src"], "javascript"))
        if tag == "link" and values.get("rel") == "stylesheet" and values.get("href"):
            self.assets.append((values["href"], "text/css"))
        if tag == "link" and values.get("rel") == "icon" and values.get("href"):
            self.assets.append((values["href"], "image/svg+xml"))


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_serves_index_and_spa_fallback(tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>Podium</title>", encoding="utf-8")
    (static / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")

    app = create_app(
        turnstile_verifier=lambda t, ip: True,
        secure_cookies=False,
        static_dir=str(static),
        store=object(),
    )
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
async def test_built_spa_deep_link_resolves_root_assets() -> None:
    static = Path(__file__).parents[1] / "packages" / "podium" / "src" / "podium" / "static"
    app = create_app(
        turnstile_verifier=lambda t, ip: True,
        secure_cookies=False,
        static_dir=str(static),
        store=object(),
    )

    async with _client(app) as client:
        spa = await client.get("/setup/linear")
        parser = _AssetParser()
        parser.feed(spa.text)
        assert parser.assets
        for reference, expected_type in parser.assets:
            path = urlsplit(urljoin(str(spa.url), reference)).path
            asset = await client.get(path)
            assert asset.status_code == 200
            assert expected_type in asset.headers["content-type"]


@pytest.mark.asyncio
async def test_health_and_service_root_unaffected_without_static() -> None:
    class HealthyStore:
        async def probe_background_job_failure_store(self) -> None:
            return None

        async def get_background_job_failure(self, _job_name: str) -> None:
            return None

    app = create_app(
        turnstile_verifier=lambda t, ip: True,
        secure_cookies=False,
        store=HealthyStore(),
    )
    async with _client(app) as client:
        health = await client.get("/api/v1/health")
        assert health.json() == {"status": "ok"}
        root = await client.get("/")
        assert root.json() == {"service": "Podium"}
