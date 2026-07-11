from __future__ import annotations

from enum import StrEnum


class RunState(StrEnum):
    PLANNING = "planning"
    AWAITING_APPROVAL = "awaiting_approval"
    EXECUTING = "executing"
    BLOCKED = "blocked"
    FAILED = "failed"
    DONE = "done"


class TaskState(StrEnum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    BLOCKED = "blocked"
    DONE = "done"


class AttemptState(StrEnum):
    RUNNING = "running"
    WAITING = "waiting"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STALE = "stale"


class StaleAttemptError(RuntimeError):
    pass


__all__ = ["AttemptState", "RunState", "StaleAttemptError", "TaskState"]
