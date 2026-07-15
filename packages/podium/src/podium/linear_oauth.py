from __future__ import annotations

import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx

from .linear_constants import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE, LINEAR_TOKEN_URL
from .linear_manifest import LINEAR_OAUTH_REDIRECT_URI, linear_oauth_client_id

LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke"


def new_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def authorization_url(state: str, challenge: str) -> str:
    return f"{LINEAR_AUTHORIZE_URL}?{urlencode({
        'client_id': linear_oauth_client_id(),
        'redirect_uri': LINEAR_OAUTH_REDIRECT_URI,
        'response_type': 'code',
        'scope': LINEAR_DEFAULT_SCOPE,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'actor': 'app',
        'prompt': 'consent',
    })}"


async def exchange_public_code(
    code: str,
    verifier: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, object]:
    async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
        response = await client.post(
            LINEAR_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": linear_oauth_client_id(),
                "redirect_uri": LINEAR_OAUTH_REDIRECT_URI,
                "code_verifier": verifier,
            },
        )
    payload = response.json()
    if response.status_code != 200 or not isinstance(payload, dict):
        raise ValueError("linear_public_token_exchange_failed")
    return payload


async def revoke_probe_tokens(
    token: dict[str, object],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
        for field, hint in (("access_token", "access_token"), ("refresh_token", "refresh_token")):
            value = token.pop(field, None)
            if not isinstance(value, str) or not value:
                continue
            response = await client.post(
                LINEAR_REVOKE_URL, data={"token": value, "token_type_hint": hint}
            )
            if response.status_code not in {200, 204}:
                raise ValueError("linear_public_token_revocation_failed")
