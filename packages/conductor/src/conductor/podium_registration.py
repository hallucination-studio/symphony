from __future__ import annotations

import json
from urllib import error, request

from performer_api.registration import ConductorRegistrationRequest

from .conductor_models import ConductorSettings


class PodiumRegistrationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def register_with_podium(settings: ConductorSettings) -> dict[str, object]:
    base_url = settings.podium_url.strip().rstrip("/")
    if not base_url:
        return {"status": "skipped", "reason": "podium_url_unset"}
    payload = ConductorRegistrationRequest(conductor_id=settings.conductor_id).to_dict()
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    headers = {"Content-Type": "application/json"}
    if settings.podium_token.strip():
        headers["Authorization"] = f"Bearer {settings.podium_token.strip()}"
    req = request.Request(
        f"{base_url}/api/v1/conductors/register",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode() or "{}")
    except error.HTTPError as exc:
        message = exc.read().decode(errors="replace")
        raise PodiumRegistrationError("podium_registration_failed", message or str(exc)) from exc
    except OSError as exc:
        raise PodiumRegistrationError("podium_unavailable", str(exc)) from exc
