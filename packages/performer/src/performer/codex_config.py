from __future__ import annotations

from dataclasses import dataclass, field
import re


_SECRET_KEY_MARKERS = ("api_key", "apikey", "token", "secret", "password")
_ENV_REFERENCE = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*")


@dataclass(frozen=True)
class CodexConfig:
    model: str | None = None
    sdk_codex_bin: str | None = None
    sandbox: str | None = None
    config_overrides: tuple[str, ...] = field(default=(), repr=False)
    hard_turn_timeout_ms: int = 3_600_000
    read_timeout_ms: int = 5_000
    init_max_attempts: int = 4
    init_backoff_ms: int = 500
    init_backoff_max_ms: int = 8_000
    overload_max_attempts: int = 5
    overload_initial_delay_ms: int = 250
    overload_max_delay_ms: int = 8_000

    def __post_init__(self) -> None:
        for override in self.config_overrides:
            key, separator, value = override.partition("=")
            if not separator or not key.strip() or not value:
                raise ValueError("Codex config overrides must be KEY=VALUE strings")
            normalized_key = re.sub(r"[-.]+", "_", key.lower())
            if any(marker in normalized_key for marker in _SECRET_KEY_MARKERS):
                if _ENV_REFERENCE.fullmatch(value.strip()) is None:
                    raise ValueError(
                        "secret-bearing Codex config override values must use $VAR indirection"
                    )
