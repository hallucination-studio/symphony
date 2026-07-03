from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

import httpx

from podium.models import LinearConnectionStatus


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class LinearCreds:
    """Resolved OAuth client credentials for a given workspace."""
    client_id: str
    client_secret: str
    redirect_uri: str


class LinearService:
    """
    Encapsulates all Linear integration concerns.

    Responsibilities:
    - OAuth token exchange and installation persistence
    - Webhook signature validation
    - GraphQL proxying with OAuth token injection
    - UI-safe connection status (never exposes tokens)

    SECURITY: OAuth access_token / refresh_token are stored internally and
    NEVER returned in any UI-facing payload.
    """

    def __init__(
        self,
        *,
        client_id: str = "",
        client_secret: str = "",
        redirect_uri: str = "",
        webhook_secret: str = "",
        token_exchange: Callable[[str, str], dict[str, Any]] | None = None,
        installations: dict[str, dict[str, Any]] | None = None,
        installations_path: str | Path | None = None,
        graphql_transport: Callable[[httpx.Request], Awaitable[httpx.Response]] | httpx.AsyncBaseTransport | None = None,
        credentials_resolver: Callable[[str], LinearCreds] | None = None,
    ):
        self.client_id = client_id or ""
        self.client_secret = client_secret or ""
        self.redirect_uri = redirect_uri or ""
        self.webhook_secret = webhook_secret or ""
        self.token_exchange = token_exchange or self._default_token_exchange
        self.installations_path = Path(installations_path) if installations_path else None
        self.installations = dict(installations or self._load_installations())
        self.graphql_transport = graphql_transport
        self.credentials_resolver = credentials_resolver or self._global_credentials

    def _global_credentials(self, workspace_id: str) -> LinearCreds:
        """Default resolver: always the official global credentials."""
        return LinearCreds(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri,
        )

    def resolve_credentials(self, state: str) -> LinearCreds:
        """Resolve OAuth credentials for the given ``state`` (workspace_id).

        The state/workspace_id is passed explicitly by callers; this method
        never reads shared instance state, so concurrent OAuth flows for
        different tenants cannot cross-contaminate credentials.
        """
        return self.credentials_resolver(state)

    # ===== OAuth =====

    def handle_oauth_callback(self, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        """
        Handle Linear OAuth callback. Stores tokens internally, returns UI-safe payload.

        access_token and refresh_token are NEVER included in the response.
        """
        code = str(query.get("code") or "").strip()
        if not code:
            return 400, {"error": {"code": "missing_code", "message": "OAuth code is required"}}
        state = str(query.get("state") or "").strip()
        if not state:
            return 400, {"error": {"code": "missing_state", "message": "OAuth state is required"}}
        # Thread state explicitly through the exchange; never stash it on self,
        # so interleaved callbacks for different tenants cannot cross.
        exchanged = self.token_exchange(code, state)
        workspace_id = str(
            exchanged.get("workspace_id")
            or exchanged.get("organization_id")
            or state
        )
        expires_in = _int(exchanged.get("expires_in"), 0)
        expires_at = None
        if expires_in > 0:
            expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat().replace("+00:00", "Z")
        installation = {
            "workspace_id": workspace_id,
            "access_token": str(exchanged.get("access_token") or ""),
            "refresh_token": str(exchanged.get("refresh_token") or ""),
            "expires_at": expires_at,
            "scope": str(exchanged.get("scope") or ""),
            "app_user_id": str(exchanged.get("app_user_id") or ""),
        }
        self.installations[workspace_id] = installation
        self._save_installations()
        return 200, {
            "installation": {
                "workspace_id": workspace_id,
                "scope": installation["scope"],
                "app_user_id": installation["app_user_id"],
                "expires_at": expires_at,
            }
        }

    def build_authorization_url(self, *, state: str, scope: str = "read,write") -> str:
        """Build a Linear OAuth authorization URL for starting the flow.

        Uses the workspace's resolved credentials (``state`` carries the
        workspace_id), so a user's custom Linear app mints the token when
        configured; otherwise the official global client is used.
        """
        creds = self.resolve_credentials(state)
        params = {
            "client_id": creds.client_id,
            "redirect_uri": creds.redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state,
        }
        return "https://linear.app/oauth/authorize?" + urlencode(params)

    # ===== Webhook signature =====

    def valid_signature(self, raw_body: bytes, headers: dict[str, str]) -> bool:
        actual = headers.get("linear-signature") or headers.get("x-linear-signature") or ""
        expected = hmac.new(self.webhook_secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(actual, expected)

    # ===== GraphQL proxy =====

    def get_installation(self, workspace_id: str) -> dict[str, Any] | None:
        return self.installations.get(workspace_id)

    async def forward_graphql(self, payload: dict[str, Any], access_token: str) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        if callable(self.graphql_transport):
            request = httpx.Request("POST", "https://api.linear.app/graphql", json=payload, headers=headers)
            response = await self.graphql_transport(request)
        else:
            async with httpx.AsyncClient(
                timeout=30,
                transport=self.graphql_transport,
                trust_env=False,
            ) as client:
                response = await client.post("https://api.linear.app/graphql", json=payload, headers=headers)
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise RuntimeError("Linear response was not valid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("Linear response was not an object")
        return data

    # ===== UI-safe status =====

    def connection_status(self, workspace_id: str) -> LinearConnectionStatus | None:
        """Return UI-safe connection status for a workspace, or None if not connected."""
        installation = self.installations.get(workspace_id)
        if not installation:
            return None
        return LinearConnectionStatus.from_installation(installation)

    # ===== Internal =====

    def _default_token_exchange(self, code: str, state: str) -> dict[str, Any]:
        creds = self.resolve_credentials(state)
        if not creds.client_id or not creds.client_secret or not creds.redirect_uri:
            raise RuntimeError("Linear OAuth token exchange is not configured")
        data = {
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "redirect_uri": creds.redirect_uri,
            "code": code,
            "grant_type": "authorization_code",
        }
        try:
            response = httpx.post("https://api.linear.app/oauth/token", data=data, timeout=30, trust_env=False)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Linear OAuth token exchange failed: {exc}") from exc
        if response.status_code != 200:
            raise RuntimeError(f"Linear OAuth token exchange returned HTTP {response.status_code}: {response.text}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("Linear OAuth token exchange returned a non-object response")
        return payload

    def _load_installations(self) -> dict[str, dict[str, Any]]:
        if self.installations_path is None or not self.installations_path.exists():
            return {}
        try:
            payload = json.loads(self.installations_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(payload, dict):
            return {}
        return {str(key): value for key, value in payload.items() if isinstance(value, dict)}

    def _save_installations(self) -> None:
        if self.installations_path is None:
            return
        self.installations_path.parent.mkdir(parents=True, exist_ok=True)
        self.installations_path.write_text(
            json.dumps(self.installations, indent=2, sort_keys=True),
            encoding="utf-8",
        )
