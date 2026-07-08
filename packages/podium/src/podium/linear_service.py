from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable

from .app import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE


@dataclass(frozen=True)
class LinearCredentials:
    client_id: str
    client_secret: str = ""
    redirect_uri: str = ""


class LinearService:
    def __init__(
        self,
        *,
        resolve_credentials: Callable[[str], LinearCredentials],
        client_id: str = "",
        redirect_uri: str = "",
    ) -> None:
        self.installations: dict[str, dict[str, Any]] = {}
        self._resolve_credentials = resolve_credentials
        self.client_id = client_id
        self.redirect_uri = redirect_uri

    def build_authorization_url(self, *, state: str) -> str:
        creds = self._resolve_credentials(state)
        query = urllib.parse.urlencode(
            {
                "client_id": creds.client_id,
                "redirect_uri": creds.redirect_uri or self.redirect_uri,
                "response_type": "code",
                "scope": LINEAR_DEFAULT_SCOPE,
                "actor": "app",
                "state": state,
                "prompt": "consent",
            }
        )
        return f"{LINEAR_AUTHORIZE_URL}?{query}"
