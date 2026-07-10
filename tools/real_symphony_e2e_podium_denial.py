from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence
from real_symphony_e2e_podium import (
    INSTALLATIONS_PATH,
    OAUTH_START_PATH,
    PodiumSession,
    _config_error,
    _validate_authorization_url,
    _write_private,
)


async def verify_denied_authorization(
    session: PodiumSession,
    *,
    active_installation_id: str,
    root: Path,
    evidence: Evidence,
    timeout_seconds: int,
) -> dict[str, Any]:
    before = await session.request("GET", INSTALLATIONS_PATH)
    previous_candidate = before.get("candidate") if isinstance(before.get("candidate"), dict) else {}
    started = await session.request("POST", OAUTH_START_PATH)
    authorization_url = str(started.get("authorization_url") or "")
    _validate_authorization_url(authorization_url)
    pending_path = root / ".linear-denial-authorization-url"
    _write_private(pending_path, authorization_url)
    print(f"event=e2e_linear_oauth_denial_required authorization_url_path={pending_path}", flush=True)
    try:
        active, denied = await _wait_for_denied_installation(
            session,
            active_installation_id=active_installation_id,
            previous_candidate_id=str(previous_candidate.get("id") or ""),
            timeout_seconds=timeout_seconds,
        )
    finally:
        pending_path.unlink(missing_ok=True)
    preserved = active.get("id") == active_installation_id and denied.get("error_code") == "linear_oauth_denied"
    evidence.check(
        "linear-oauth:denial-preserves-active-installation",
        preserved,
        active_installation_id=active.get("id"),
        denied_installation_id=denied.get("id"),
        error_code=denied.get("error_code"),
        sanitized_reason=denied.get("sanitized_reason"),
    )
    if not preserved:
        raise _config_error(
            "linear_oauth_denial_evidence_incomplete",
            "Denied consent did not preserve the active Linear installation",
            "inspect_linear_installations",
        )
    return denied


async def _wait_for_denied_installation(
    session: PodiumSession,
    *,
    active_installation_id: str,
    previous_candidate_id: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        payload = await session.request("GET", INSTALLATIONS_PATH)
        active = payload.get("active") if isinstance(payload.get("active"), dict) else {}
        if active.get("id") != active_installation_id:
            raise _config_error(
                "linear_oauth_denial_changed_active_installation",
                "Denied consent changed the active Linear installation",
                "inspect_linear_installations",
            )
        candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
        if candidate.get("id") and candidate.get("id") != previous_candidate_id:
            if candidate.get("state") == "failed" and candidate.get("error_code") == "linear_oauth_denied":
                return active, candidate
            if candidate.get("state") == "failed":
                raise _config_error(
                    str(candidate.get("error_code") or "linear_oauth_denial_failed"),
                    str(candidate.get("sanitized_reason") or "Linear denial probe failed"),
                    str(candidate.get("next_action") or "inspect_linear_installations"),
                )
        await asyncio.sleep(0.5)
    raise _config_error(
        "linear_oauth_denial_timeout",
        "Linear OAuth denial callback was not completed",
        "deny_linear_oauth_consent",
    )
