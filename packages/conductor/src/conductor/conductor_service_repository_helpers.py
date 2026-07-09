from __future__ import annotations

from typing import Any

from .conductor_models import InstanceRecord
from .conductor_repository_handoff import (
    repository_handoff_closeout_event,
    repository_handoff_comment,
    repository_handoff_marker,
    repository_integration_description,
)
from performer_api.ops_models import OpsSnapshot, TraceEvent

__all__ = [
    "_repository_handoff_marker",
    "_repository_handoff_closeout_event",
    "_repository_integration_description",
    "_repository_handoff_comment",
]


def _repository_handoff_marker(source_issue_id: str) -> str:
    return repository_handoff_marker(source_issue_id)


def _repository_handoff_closeout_event(
    snapshot: OpsSnapshot,
    *,
    source_event: TraceEvent,
    status: str,
    payload: dict[str, Any],
) -> TraceEvent:
    return repository_handoff_closeout_event(snapshot, source_event=source_event, status=status, payload=payload)


def _repository_integration_description(report: dict[str, Any], *, instance: InstanceRecord) -> str:
    return repository_integration_description(report, instance=instance)


def _repository_handoff_comment(report: dict[str, Any], *, child: dict[str, Any], mention: str) -> str:
    return repository_handoff_comment(report, child=child, mention=mention)
