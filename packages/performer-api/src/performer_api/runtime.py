from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeConfig:
    codex_home: str
    model: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"codex_home": self.codex_home, "model": self.model}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfig:
        return cls(codex_home=str(payload.get("codex_home") or ""), model=str(payload.get("model") or ""))


__all__ = ["RuntimeConfig"]
