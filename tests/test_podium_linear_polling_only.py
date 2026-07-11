from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.linear_constants import LINEAR_REQUIRED_SCOPES

def test_linear_oauth_scope_is_the_polling_only_minimum() -> None:
    assert LINEAR_REQUIRED_SCOPES == {"read", "write", "app:assignable"}


@pytest.mark.asyncio
async def test_default_and_custom_apps_need_no_webhook_configuration() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=object(),
    )
    app.state.podium.user_for_session = AsyncMock(
        return_value={"id": "user-1", "email": "owner@example.com"}
    )
    app.state.podium.selected_linear_application = AsyncMock(
        return_value={
            "id": "default-application",
            "source": "default",
            "version": 7,
            "client_id": "default-client",
            "client_secret": "default-secret",
            "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
        }
    )
    app.state.podium.stage_custom_linear_application = AsyncMock(
        return_value={
            "id": "custom-application",
            "source": "custom",
            "version": 1,
            "client_id": "custom-client",
            "client_secret": "custom-secret",
            "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
        }
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        default = await client.get("/api/v1/linear/application")
        custom = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom-client", "client_secret": "custom-secret"},
        )
        missing_route = await client.post("/api/v1/linear/webhooks", json={})

    assert default.json()["application"] == {
        "id": "default-application",
        "source": "default",
        "version": 7,
        "client_id": "default-client",
        "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
    }
    assert custom.status_code == 200
    assert custom.json()["application"]["source"] == "custom"
    assert "secret" not in custom.text.lower()
    assert missing_route.status_code == 404
