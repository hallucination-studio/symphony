from __future__ import annotations

from typing import Any


class NoopPipelineIngress:
    async def poll(self) -> int:
        return 0


def _check(name: str, passed: bool, report: dict[str, Any], **details: Any) -> None:
    row = {"name": name, "passed": passed, **details}
    report["checks"].append(row)
    if not passed:
        report["failures"].append(row)


def _assert_schedule(
    *,
    report: dict[str, Any],
    timeline: list[dict[str, Any]],
    runtime_started: list[dict[str, Any]],
    child_a_id: str,
    child_b_id: str,
    child_c_id: str,
    global_capacity: int,
) -> None:
    started_by_issue = {row["issue_id"]: row for row in runtime_started}
    a_start = started_by_issue.get(child_a_id)
    b_start = started_by_issue.get(child_b_id)
    c_start = started_by_issue.get(child_c_id)
    a_done_tick = _terminal_tick(timeline, child_a_id)
    c_start_tick = _start_tick(timeline, child_c_id)
    same_tick_parallel = _parallel_overlap_observed(timeline, child_a_id, child_b_id)
    before_a_done = [sample for sample in timeline if a_done_tick is None or sample["tick"] < a_done_tick]
    c_never_started_before_a_done = _not_started_in_samples(before_a_done, child_c_id)
    c_blocked_before_a_done = _blocked_waiting_in_samples(before_a_done, child_c_id)
    c_dispatchable_or_started_after_a_done = _dispatchable_or_started_after(timeline, a_done_tick, child_c_id)
    c_started_after_a_done = bool(a_done_tick is not None and c_start_tick is not None and c_start_tick > a_done_tick)
    capacity_non_cause = _capacity_non_cause(before_a_done, child_c_id, global_capacity)
    blocked_waiting_visible = any(sample["background"].get("blocked_waiting", 0) >= 1 for sample in before_a_done)

    _check("parallel:A-and-B-start-same-tick-or-overlap", same_tick_parallel, report, starts=[a_start, b_start])
    _check(
        "dependency-gate:C-waits-before-A-terminal",
        c_never_started_before_a_done and c_blocked_before_a_done,
        report,
        a_done_tick=a_done_tick,
        c_start_tick=c_start_tick,
    )
    _check(
        "dependency-release:C-dispatches-after-A-terminal",
        c_dispatchable_or_started_after_a_done and c_started_after_a_done,
        report,
        a_done_tick=a_done_tick,
        c_start_tick=c_start_tick,
        c_start=c_start,
    )
    _check(
        "capacity-non-cause:C-waits-with-capacity-available",
        capacity_non_cause,
        report,
        global_capacity=global_capacity,
    )
    _check("readiness-counts:blocked-waiting-visible", blocked_waiting_visible, report)


def _terminal_tick(timeline: list[dict[str, Any]], issue_id: str) -> int | None:
    return next(
        (
            sample["tick"]
            for sample in timeline
            for node in sample["nodes"]
            if node["issue_id"] == issue_id and node["state"] in {"verify_passed", "failed"}
        ),
        None,
    )


def _start_tick(timeline: list[dict[str, Any]], issue_id: str) -> int | None:
    return next(
        (sample["tick"] for sample in timeline if any(start["issue_id"] == issue_id for start in sample["started_this_tick"])),
        None,
    )


def _parallel_overlap_observed(timeline: list[dict[str, Any]], child_a_id: str, child_b_id: str) -> bool:
    expected = {child_a_id, child_b_id}
    return any(
        expected.issubset({start["issue_id"] for start in sample["started_this_tick"]})
        or expected.issubset({node["issue_id"] for node in sample["nodes"] if node["state"] in {"executing", "verifying"}})
        for sample in timeline
    )


def _not_started_in_samples(samples: list[dict[str, Any]], issue_id: str) -> bool:
    return all(not any(start["issue_id"] == issue_id for start in sample["started_this_tick"]) for sample in samples)


def _blocked_waiting_in_samples(samples: list[dict[str, Any]], issue_id: str) -> bool:
    return any(
        any(node["issue_id"] == issue_id and node["state"] in {"planned", "ready"} and not node["is_dispatchable"] for node in sample["nodes"])
        and sample["background"].get("blocked_waiting", 0) >= 1
        for sample in samples
    )


def _dispatchable_or_started_after(timeline: list[dict[str, Any]], after_tick: int | None, issue_id: str) -> bool:
    return any(
        sample["tick"] > after_tick
        and (
            any(node["issue_id"] == issue_id and node["is_dispatchable"] for node in sample["nodes"])
            or any(start["issue_id"] == issue_id for start in sample["started_this_tick"])
        )
        for sample in timeline
        if after_tick is not None
    )


def _capacity_non_cause(samples: list[dict[str, Any]], issue_id: str, global_capacity: int) -> bool:
    return global_capacity >= 3 and any(
        sample["background"].get("blocked_waiting", 0) >= 1
        and any(node["issue_id"] == issue_id and not node["is_dispatchable"] for node in sample["nodes"])
        and len([node for node in sample["nodes"] if node["state"] in {"executing", "verifying", "replanning"}]) < global_capacity
        for sample in samples
    )
