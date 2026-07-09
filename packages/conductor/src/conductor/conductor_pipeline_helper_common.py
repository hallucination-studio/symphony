from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from performer_api.pipeline import (
    AttemptState,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PASS_THRESHOLD,
    PlanValidatorError,
    RuntimeMode,
)

_UNCHANGED = object()
_DISPATCHABLE_STATES = {
    GraphNodeState.READY,
    GraphNodeState.REPLANNING,
    GraphNodeState.VERIFYING,
}
_PREDICTABLE_DISPATCH_STATES = {
    GraphNodeState.PLANNED,
    *_DISPATCHABLE_STATES,
}
_PROCESS_EXIT_RESULT_GRACE_SECONDS = 15.0

__all__ = [name for name in globals() if not name.startswith("__")]
