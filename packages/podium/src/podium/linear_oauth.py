from __future__ import annotations

from urllib.parse import urlencode

import httpx

from .linear_constants import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE, LINEAR_TOKEN_URL
from .linear_manifest import LINEAR_OAUTH_REDIRECT_URI, linear_oauth_client_id
from .oauth_state import generate_pkce

LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke"


def new_pkce() -> tuple[str, str]:
    return generate_pkce()


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


async def refresh_public_token(
    refresh_token: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, object]:
    async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
        response = await client.post(
            LINEAR_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": linear_oauth_client_id(),
            },
        )
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError("linear_token_refresh_failed") from error
    if response.status_code != 200 or not isinstance(payload, dict):
        code = (
            "linear_invalid_grant"
            if response.status_code == 400
            and isinstance(payload, dict)
            and payload.get("error") == "invalid_grant"
            else "linear_token_refresh_failed"
        )
        raise ValueError(code)
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
