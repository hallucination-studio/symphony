from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PodiumConfig:
    database_url: str = ""
    redis_url: str = ""

    @classmethod
    def from_env(cls) -> PodiumConfig:
        return cls(
            database_url=os.environ.get("PODIUM_DATABASE_URL", "").strip(),
            redis_url=os.environ.get("PODIUM_REDIS_URL", "").strip(),
        )
