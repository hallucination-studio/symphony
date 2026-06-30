from __future__ import annotations

from dataclasses import dataclass, replace

from .ops_models import OpsSnapshot, TraceEvent


@dataclass(frozen=True)
class RetentionPolicy:
    max_raw_events: int = 200
    max_trace_events: int = 1000

    def apply(self, snapshot: OpsSnapshot) -> OpsSnapshot:
        pinned_issue_ids = set(snapshot.retention.pinned_issue_ids)
        pinned_run_ids = set(snapshot.retention.pinned_run_ids)
        pinned = [
            event
            for event in snapshot.events
            if (event.issue_id is not None and event.issue_id in pinned_issue_ids)
            or (event.run_id is not None and event.run_id in pinned_run_ids)
        ]
        pinned_ids = {event.event_id for event in pinned}
        summary = [
            event
            for event in snapshot.events
            if event.retention_tier == "summary" and event.event_id not in pinned_ids
        ]
        trace = [
            event
            for event in snapshot.events
            if event.retention_tier == "trace" and event.event_id not in pinned_ids
        ]
        raw = [
            event
            for event in snapshot.events
            if event.retention_tier == "raw" and event.event_id not in pinned_ids
        ]
        trace = _newest_first(trace)[: self.max_trace_events]
        raw = _newest_first(raw)[: self.max_raw_events]
        kept = _dedupe(pinned + summary + _oldest_first(trace) + _oldest_first(raw))
        return replace(snapshot, events=kept)


def _newest_first(events: list[TraceEvent]) -> list[TraceEvent]:
    return sorted(events, key=_retention_sort_key, reverse=True)


def _oldest_first(events: list[TraceEvent]) -> list[TraceEvent]:
    return sorted(events, key=_retention_sort_key)


def _retention_sort_key(event: TraceEvent) -> tuple[str, str]:
    return (event.timestamp, event.event_id)


def _dedupe(events: list[TraceEvent]) -> list[TraceEvent]:
    seen: set[str] = set()
    kept: list[TraceEvent] = []
    for event in events:
        if event.event_id in seen:
            continue
        seen.add(event.event_id)
        kept.append(event)
    return kept
