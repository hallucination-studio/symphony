from __future__ import annotations

from typing import Callable, Protocol

from .config import ConfigError, TrackerConfig
from .linear import LinearTracker
from .models import Issue


class TrackerAdapter(Protocol):
    async def fetch_candidate_issues(self) -> list[Issue]: ...

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]: ...

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]: ...


TrackerFactory = Callable[[TrackerConfig], TrackerAdapter]


_TRACKER_ADAPTERS: dict[str, TrackerFactory] = {
    "linear": LinearTracker,
}


def register_tracker_adapter(kind: str, factory: TrackerFactory) -> None:
    key = kind.strip().lower()
    if not key:
        raise ConfigError("invalid_tracker_kind", "tracker kind cannot be blank")
    _TRACKER_ADAPTERS[key] = factory


def create_tracker(config: TrackerConfig) -> TrackerAdapter:
    factory = _TRACKER_ADAPTERS.get(config.kind.strip().lower())
    if factory is None:
        raise ConfigError("unsupported_tracker_kind", f"Unsupported tracker kind: {config.kind}")
    return factory(config)


def is_registered_tracker_kind(kind: str) -> bool:
    return kind.strip().lower() in _TRACKER_ADAPTERS
