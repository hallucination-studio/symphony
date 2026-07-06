from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conductor.conductor_phase import (
    PhaseReducer,
    PhaseTransitionError,
    RunStatus,
)
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


__all__ = [name for name in globals() if not name.startswith("__")]
