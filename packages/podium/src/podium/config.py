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
    linear_client_id: str = ""
    linear_client_secret: str = ""
    linear_redirect_uri: str = ""
    linear_application_version: int = 1
    linear_reconciliation_interval_seconds: int = 15
    linear_reconciliation_page_size: int = 50
    linear_reconciliation_initial_lookback_seconds: int = 0

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
            linear_client_id=os.environ.get("LINEAR_CLIENT_ID", "").strip(),
            linear_client_secret=os.environ.get("LINEAR_CLIENT_SECRET", "").strip(),
            linear_redirect_uri=os.environ.get("LINEAR_REDIRECT_URI", "").strip(),
            linear_application_version=_env_int("LINEAR_APPLICATION_VERSION", 1),
            linear_reconciliation_interval_seconds=_env_int(
                "PODIUM_LINEAR_RECONCILIATION_INTERVAL_SECONDS",
                15,
            ),
            linear_reconciliation_page_size=_env_int("PODIUM_LINEAR_RECONCILIATION_PAGE_SIZE", 50),
            linear_reconciliation_initial_lookback_seconds=_env_int(
                "PODIUM_LINEAR_RECONCILIATION_INITIAL_LOOKBACK_SECONDS",
                0,
            ),
        )


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
