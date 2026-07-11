from __future__ import annotations

from enum import StrEnum


class ManagedRunState(StrEnum):
    QUEUED = "queued"
    PLANNING = "planning"
    PROJECTING_PLAN = "projecting_plan"
    AWAITING_APPROVAL = "awaiting_approval"
    READY = "ready"
    EXECUTING = "executing"
    REVIEWING = "reviewing"
    VERIFIED = "verified"
    RECONCILING_LINEAR_CHANGE = "reconciling_linear_change"
    BLOCKED = "blocked"
    FAILED = "failed"
    DONE = "done"


class WorkItemState(StrEnum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    DONE = "done"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


__all__ = ["ManagedRunState", "WorkItemState"]
