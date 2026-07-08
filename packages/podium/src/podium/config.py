from __future__ import annotations

import os
from dataclasses import dataclass


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class PodiumConfig:
    database_url: str = ""
    turnstile_site_key: str = ""
    turnstile_secret_key: str = ""
    turnstile_disabled: bool = False
    linear_application_id: str = ""
    linear_app_access_token: str = ""
    linear_poll_interval_seconds: int = 15
    linear_poll_page_size: int = 50
    linear_poll_initial_lookback_seconds: int = 0

    @classmethod
    def from_env(cls) -> PodiumConfig:
        return cls(
            database_url=os.environ.get("PODIUM_DATABASE_URL", "").strip(),
            turnstile_site_key=os.environ.get("CLOUDFLARE_TURNSTILE_SITE_KEY", "").strip(),
            turnstile_secret_key=os.environ.get("CLOUDFLARE_TURNSTILE_SECRET_KEY", "").strip(),
            turnstile_disabled=(
                _env_flag("PODIUM_DISABLE_TURNSTILE")
                or _env_flag("PODIUM_DEBUG_DISABLE_TURNSTILE")
                or _env_flag("PODIUM_DEBUG_AUTH")
            ),
            linear_application_id=os.environ.get("PODIUM_LINEAR_APPLICATION_ID", "").strip(),
            linear_app_access_token=os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "").strip(),
            linear_poll_interval_seconds=_env_int("PODIUM_LINEAR_POLL_INTERVAL_SECONDS", 15),
            linear_poll_page_size=_env_int("PODIUM_LINEAR_POLL_PAGE_SIZE", 50),
            linear_poll_initial_lookback_seconds=_env_int("PODIUM_LINEAR_POLL_INITIAL_LOOKBACK_SECONDS", 0),
        )


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
