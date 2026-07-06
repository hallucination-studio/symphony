from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from conductor.conductor_models import ConductorSettings, InstanceCreateRequest
from conductor.conductor_runtime import ConductorRuntimeManager
from conductor.conductor_scheduler import SchedulerPolicy
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceRequest, PhaseAdvanceResult, RunPhase

from linear_tree_audit import summarize_tree
from real_symphony_e2e import (
    create_linear_blocks_relation,
    create_linear_issue,
    fetch_linear_issue,
    linear_graphql,
    utc_now,
)


class ProbeProcess:
    def __init__(self, pid: int = 4242):
        self.pid = pid
        self.returncode: int | None = None

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(0.02)
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = 0


class ProbeRuntimeManager(ConductorRuntimeManager):
    def __init__(self, *, completion_delay_seconds: float):
        super().__init__()
        self.completion_delay_seconds = completion_delay_seconds
        self.started: list[dict[str, Any]] = []
        self._processes: dict[str, ProbeProcess] = {}

    async def start(
        self,
        instance,
        *,
        env: dict[str, str] | None = None,
        advance_request_path: str | None = None,
        phase_result_path: str | None = None,
    ):
        _ = env
        process = ProbeProcess(pid=4000 + len(self.started) + 1)
        self._processes[instance.id] = process
        request = PhaseAdvanceRequest.from_dict(json.loads(Path(str(advance_request_path)).read_text(encoding="utf-8")))
        self.started.append(
            {
                "at": utc_now(),
                "instance_id": instance.id,
                "issue_id": request.issue_id,
                "issue_identifier": request.issue_identifier,
                "run_id": request.run_id,
                "current_phase": request.current_phase.value,
                "request_path": advance_request_path,
                "result_path": phase_result_path,
            }
        )
        asyncio.create_task(self._complete_after_delay(request, Path(str(phase_result_path)), process))
        return instance.with_updates(process_status="running", pid=process.pid)

    def refresh(self, instance):
        process = self._processes.get(instance.id)
        if process is None:
            return instance
        if process.returncode is None:
            return instance.with_updates(process_status="running", pid=process.pid)
        self._processes.pop(instance.id, None)
        return instance.with_updates(process_status="exited", pid=None, last_exit_code=process.returncode)

    async def stop(self, instance):
        process = self._processes.pop(instance.id, None)
        if process is not None:
            process.terminate()
        return instance.with_updates(process_status="stopped", pid=None)

    async def _complete_after_delay(self, request: PhaseAdvanceRequest, result_path: Path, process: ProbeProcess) -> None:
        await asyncio.sleep(self.completion_delay_seconds)
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result = PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=request.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason="probe_smoke_completed",
        )
        result_path.write_text(json.dumps(result.to_dict(), sort_keys=True), encoding="utf-8")
        process.returncode = 0


class NoopDirectIngress:
    async def poll(self) -> int:
        return 0


def _make_fixture_repo(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    (path / "README.md").write_text("Symphony concurrent schedule probe fixture.\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "concurrent-probe@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Symphony Concurrent Probe"], cwd=path, check=True)
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)
    return path


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


async def _archive_issue(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation ArchiveIssue($id: String!) {
              issueArchive(id: $id) { success entity { id } }
            }
            """,
            {"id": issue_id},
        )
    )["issueArchive"]


async def _create_issue_tree(token: str, project_slug: str, run_id: str) -> dict[str, Any]:
    parent = await create_linear_issue(
        token,
        project_slug,
        run_id,
        title=f"Symphony concurrent schedule probe parent {run_id}",
        description="Real Symphony concurrent schedule probe parent issue.",
    )
    parent_issue = parent["issue"]
    child_a = await create_linear_issue(
        token,
        project_slug,
        run_id,
        parent_id=parent_issue["id"],
        title=f"Symphony concurrent schedule probe child A {run_id}",
        description="Probe child A. This issue is the blocker for child C.",
    )
    child_b = await create_linear_issue(
        token,
        project_slug,
        run_id,
        parent_id=parent_issue["id"],
        title=f"Symphony concurrent schedule probe child B {run_id}",
        description="Probe child B. This issue has no blockers.",
    )
    child_c = await create_linear_issue(
        token,
        project_slug,
        run_id,
        parent_id=parent_issue["id"],
        title=f"Symphony concurrent schedule probe child C {run_id}",
        description="Probe child C. This issue is blocked by child A.",
    )
    relation = await create_linear_blocks_relation(token, child_a["issue"]["id"], child_c["issue"]["id"])
    return {
        "project": parent["project"],
        "team": parent["team"],
        "todo_state": parent["todo_state"],
        "parent": parent_issue,
        "children": {
            "A": child_a["issue"],
            "B": child_b["issue"],
            "C": child_c["issue"],
        },
        "blocks_relation": relation,
    }


def _run_rows(service: ConductorService) -> list[dict[str, Any]]:
    rows = []
    for run in service.store.list_orchestration_runs():
        row = run.to_dict()
        row["is_dispatchable"] = service.scheduler.is_dispatchable(run)
        rows.append(row)
    return sorted(rows, key=lambda item: (item.get("issue_identifier") or "", item.get("run_id") or ""))


def _issue_runs_by_id(service: ConductorService) -> dict[str, Any]:
    return {run.issue_id: run for run in service.store.list_orchestration_runs()}


def _started_since(runtime: ProbeRuntimeManager, index: int) -> list[dict[str, Any]]:
    return runtime.started[index:]


def _phase_sequences(service: ConductorService) -> dict[str, Any]:
    sequences: dict[str, Any] = {}
    for run in service.store.list_orchestration_runs():
        events = [event.to_dict() for event in service.store.list_orchestration_events(run.run_id)]
        sequences[run.issue_id] = {
            "issue_identifier": run.issue_identifier,
            "run_id": run.run_id,
            "blocked_by": list(run.blocked_by or []),
            "parent_issue_id": run.parent_issue_id,
            "events": events,
            "phase_sequence": [event.get("to_phase") for event in events if event.get("to_phase")],
        }
    return sequences


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
    a_done_tick = next(
        (
            sample["tick"]
            for sample in timeline
            for run in sample["runs"]
            if run["issue_id"] == child_a_id and run["phase"] in {"done", "failed"}
        ),
        None,
    )
    c_start_tick = next(
        (
            sample["tick"]
            for sample in timeline
            if any(start["issue_id"] == child_c_id for start in sample["started_this_tick"])
        ),
        None,
    )
    same_tick_parallel = any(
        {child_a_id, child_b_id}.issubset({start["issue_id"] for start in sample["started_this_tick"]})
        or {child_a_id, child_b_id}.issubset(
            {run["issue_id"] for run in sample["runs"] if run["phase"] == "implementing"}
        )
        for sample in timeline
    )
    before_a_done = [sample for sample in timeline if a_done_tick is None or sample["tick"] < a_done_tick]
    c_never_started_before_a_done = all(
        not any(start["issue_id"] == child_c_id for start in sample["started_this_tick"]) for sample in before_a_done
    )
    c_blocked_before_a_done = any(
        any(
            run["issue_id"] == child_c_id and run["phase"] == "queued" and not run["is_dispatchable"]
            for run in sample["runs"]
        )
        and sample["background"].get("blocked_waiting", 0) >= 1
        for sample in before_a_done
    )
    c_dispatchable_or_started_after_a_done = any(
        sample["tick"] > a_done_tick
        and (
            any(run["issue_id"] == child_c_id and run["is_dispatchable"] for run in sample["runs"])
            or any(start["issue_id"] == child_c_id for start in sample["started_this_tick"])
        )
        for sample in timeline
        if a_done_tick is not None
    )
    c_started_after_a_done = bool(a_done_tick is not None and c_start_tick is not None and c_start_tick > a_done_tick)
    capacity_non_cause = global_capacity >= 3 and any(
        sample["background"].get("blocked_waiting", 0) >= 1
        and any(run["issue_id"] == child_c_id and not run["is_dispatchable"] for run in sample["runs"])
        and len([run for run in sample["runs"] if run["phase"] in {"implementing", "reviewing", "reworking"}]) < global_capacity
        for sample in before_a_done
    )
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


async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY", "").strip()
    if not token:
        raise RuntimeError("LINEAR_API_KEY is required")
    if args.global_capacity < 3:
        raise RuntimeError("--global-capacity must be >= 3 for capacity-non-cause evidence")
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    out = (args.out or Path(f".test-real-flow/evidence/concurrent-schedule-{timestamp}")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "real-concurrent-schedule-probe-report.json"
    timeline_path = out / "dispatch-timeline.jsonl"
    phases_path = out / "phase-sequences.json"
    tree_path = out / "linear-tree.json"
    cleanup_path = out / "cleanup.json"
    run_id = f"concurrent-schedule-{uuid.uuid4().hex[:8]}"
    report: dict[str, Any] = {
        "started_at": utc_now(),
        "run_id": run_id,
        "global_capacity": args.global_capacity,
        "project_slug": args.project_slug,
        "artifacts": {
            "report": str(report_path),
            "timeline": str(timeline_path),
            "phase_sequences": str(phases_path),
            "linear_tree": str(tree_path),
            "conductor_data": str(out / "conductor-data"),
            "cleanup": str(cleanup_path),
        },
        "checks": [],
        "failures": [],
        "notes": [
            "Probe runtime writes short PhaseAdvanceResult(done) files to isolate scheduler behavior from Codex output.",
            "Dependency release is still scheduler-driven: child C is never manually moved or directly started.",
            "The probe seeds the three child runs from the real Linear tree and disables direct candidate polling to avoid duplicate claims across probe instances.",
        ],
    }
    _write_json(report_path, report)
    issue_ids: list[str] = []
    runtime: ProbeRuntimeManager | None = None
    service: ConductorService | None = None
    try:
        linear = await _create_issue_tree(token, args.project_slug, run_id)
        issue_ids = [
            linear["parent"]["id"],
            linear["children"]["A"]["id"],
            linear["children"]["B"]["id"],
            linear["children"]["C"]["id"],
        ]
        report["issues"] = {
            "parent": linear["parent"],
            "children": linear["children"],
            "blocks_relation": linear["blocks_relation"],
        }
        for label, child in linear["children"].items():
            fetched = await fetch_linear_issue(token, child["id"])
            _check(
                f"linear-parent:{label}",
                (fetched.get("parent") or {}).get("id") == linear["parent"]["id"],
                report,
                parent=fetched.get("parent"),
                expected_parent_id=linear["parent"]["id"],
            )
        _check(
            "linear-blocks-relation:A-blocks-C",
            (linear["blocks_relation"].get("issue") or {}).get("id") == linear["children"]["A"]["id"]
            and (linear["blocks_relation"].get("relatedIssue") or {}).get("id") == linear["children"]["C"]["id"],
            report,
            relation=linear["blocks_relation"],
        )
        _write_json(report_path, report)

        runtime = ProbeRuntimeManager(completion_delay_seconds=args.completion_delay)
        service = ConductorService(
            store=ConductorStore(out / "conductor-data"),
            data_root=out / "conductor-data",
            runtime_manager=runtime,
        )
        service.scheduler.policy = SchedulerPolicy(global_capacity=args.global_capacity)
        service.direct_ingress = NoopDirectIngress()
        service.update_settings(ConductorSettings(managed_mode=False))
        for label, issue in linear["children"].items():
            fixture = _make_fixture_repo(out / f"fixture-repo-{label.lower()}")
            payload = InstanceCreateRequest(
                name=f"Concurrent {label} {issue['identifier']} {run_id}",
                repo_source_type="local_path",
                repo_source_value=str(fixture),
                linear_project=linear["project"]["slugId"],
                linear_filters={"active_states": ["Todo", "In Progress"]},
                workflow_profile="task",
                workflow_inputs={"goal": f"Probe concurrent schedule child {label}."},
            )
            instance = service.create_instance(payload)
            service.phase_reducer.dispatch_received(
                instance_id=instance.id,
                issue_id=issue["id"],
                issue_identifier=issue["identifier"],
                workflow_profile=instance.workflow_profile,
                dispatch_id=None,
                blocked_by=[linear["children"]["A"]["id"]] if label == "C" else [],
                parent_issue_id=linear["parent"]["id"],
            )

        timeline: list[dict[str, Any]] = []
        deadline = time.monotonic() + args.timeout
        tick = 0
        while time.monotonic() < deadline:
            tick += 1
            start_index = len(runtime.started)
            background = await service.coordinate_background_once()
            for instance in service.store.list_instances():
                service.get_instance(instance.id)
            runs = _run_rows(service)
            sample = {
                "tick": tick,
                "at": utc_now(),
                "background": background,
                "started_this_tick": _started_since(runtime, start_index),
                "runs": runs,
            }
            timeline.append(sample)
            with timeline_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(sample, sort_keys=True) + "\n")
            by_issue = _issue_runs_by_id(service)
            if all(by_issue.get(issue["id"]) and by_issue[issue["id"]].phase is RunPhase.DONE for issue in linear["children"].values()):
                break
            await asyncio.sleep(args.tick_interval)
        report["timeline_ticks"] = len(timeline)
        report["runtime_starts"] = list(runtime.started)
        _write_json(phases_path, _phase_sequences(service))
        tree = summarize_tree(await _fetch_tree_for_summary(token, linear["parent"]["id"]))
        _write_json(tree_path, tree)
        report["final_runs"] = _run_rows(service)
        report["completed_at"] = utc_now()
        _assert_schedule(
            report=report,
            timeline=timeline,
            runtime_started=runtime.started,
            child_a_id=linear["children"]["A"]["id"],
            child_b_id=linear["children"]["B"]["id"],
            child_c_id=linear["children"]["C"]["id"],
            global_capacity=args.global_capacity,
        )
        blocks = tree.get("blocks_relations") or []
        _check(
            "linear-tree:parent-children-and-blocks-visible",
            {child["id"] for child in tree.get("children", [])}
            == {linear["children"]["A"]["id"], linear["children"]["B"]["id"], linear["children"]["C"]["id"]}
            and any(
                (relation.get("issue") or {}).get("id") == linear["children"]["A"]["id"]
                and (relation.get("relatedIssue") or {}).get("id") == linear["children"]["C"]["id"]
                for relation in blocks
            ),
            report,
            child_count=len(tree.get("children", [])),
            blocks_relations=blocks,
        )
    except Exception as exc:
        diagnostics = getattr(exc, "diagnostics", None)
        report["error"] = {"type": type(exc).__name__, "message": str(exc), "diagnostics": diagnostics}
        _write_json(report_path, report)
        raise
    finally:
        if service is not None:
            for instance in service.store.list_instances():
                await service.stop_instance(instance.id)
        cleanup: dict[str, Any] = {"started_at": utc_now(), "issues": [], "archived_count": 0, "failures": []}
        for issue_id in issue_ids:
            try:
                before = await fetch_linear_issue(token, issue_id)
                archive = await _archive_issue(token, issue_id)
                cleanup["issues"].append({"before": before, "archive": archive})
                if archive.get("success"):
                    cleanup["archived_count"] += 1
            except Exception as exc:
                cleanup["failures"].append({"issue_id": issue_id, "error": str(exc)})
        cleanup["completed_at"] = utc_now()
        _write_json(cleanup_path, cleanup)
        if issue_ids:
            _check(
                "cleanup:archive-created-issues",
                cleanup.get("archived_count") == len(issue_ids) and not cleanup.get("failures"),
                report,
                cleanup=cleanup,
            )
    _write_json(report_path, report)
    return report


async def _fetch_tree_for_summary(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query ConcurrentProbeTree($issueId: String!) {
              issue(id: $issueId) {
                id
                identifier
                title
                url
                description
                state { name type }
                labels { nodes { name } }
                parent { id identifier }
                inverseRelations {
                  nodes {
                    id
                    type
                    issue { id identifier title }
                    relatedIssue { id identifier title }
                  }
                }
                children(first: 100) {
                  nodes {
                    id
                    identifier
                    title
                    url
                    description
                    parent { id identifier }
                    state { name type }
                    labels { nodes { name } }
                    inverseRelations {
                      nodes {
                        id
                        type
                        issue { id identifier title }
                        relatedIssue { id identifier title }
                      }
                    }
                    children(first: 100) {
                      nodes {
                        id
                        identifier
                        title
                        url
                        description
                        parent { id identifier }
                        state { name type }
                        labels { nodes { name } }
                      }
                    }
                  }
                }
              }
            }
            """,
            {"issueId": issue_id},
        )
    )["issue"]


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Run a real Linear concurrent scheduler dependency probe.")
    arg_parser.add_argument("--out", type=Path)
    arg_parser.add_argument("--project-slug", default="8ab43179fb54")
    arg_parser.add_argument("--timeout", type=int, default=120)
    arg_parser.add_argument("--global-capacity", type=int, default=3)
    arg_parser.add_argument("--completion-delay", type=float, default=1.5)
    arg_parser.add_argument("--tick-interval", type=float, default=0.25)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    try:
        report = asyncio.run(run(args))
    except Exception as exc:
        print(f"real_concurrent_schedule_probe failed: {exc!r}")
        return 1
    report_path = Path(report["artifacts"]["report"])
    print(json.dumps({"report": str(report_path), "failures": len(report["failures"])}, indent=2))
    return 0 if not report["failures"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
