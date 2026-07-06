from __future__ import annotations

import os
from dataclasses import dataclass


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class PodiumConfig:
    database_url: str = ""
    redis_url: str = ""
    turnstile_site_key: str = ""
    turnstile_secret_key: str = ""
    turnstile_disabled: bool = False

    @classmethod
    def from_env(cls) -> PodiumConfig:
        return cls(
            database_url=os.environ.get("PODIUM_DATABASE_URL", "").strip(),
            redis_url=os.environ.get("PODIUM_REDIS_URL", "").strip(),
            turnstile_site_key=os.environ.get("CLOUDFLARE_TURNSTILE_SITE_KEY", "").strip(),
            turnstile_secret_key=os.environ.get("CLOUDFLARE_TURNSTILE_SECRET_KEY", "").strip(),
            turnstile_disabled=(
                _env_flag("PODIUM_DISABLE_TURNSTILE")
                or _env_flag("PODIUM_DEBUG_DISABLE_TURNSTILE")
                or _env_flag("PODIUM_DEBUG_AUTH")
            ),
        )
