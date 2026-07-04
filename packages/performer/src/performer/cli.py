from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .acceptance import CodexAcceptanceRunner, SmokeAcceptanceRunner
from performer_api.config import ServiceConfig, load_env_file
from performer_api.phase import PhaseAdvanceRequest, PhaseAdvanceResult, RunPhase
from .linear import LinearTracker
from .orchestrator import Orchestrator
from performer_api.persistence import PersistenceStore
from .reloader import WorkflowReloader
from .runner import AgentRunner
from .tracker import create_tracker, validate_tracker_config
from performer_api.workflow import load_workflow
from .workspace import WorkspaceManager


def default_workflow_path(cwd: Path | None = None) -> Path:
    return (cwd or Path.cwd()) / "WORKFLOW.md"


def build_config_from_path(path: Path) -> ServiceConfig:
    load_env_file(path.parent / ".env")
    workflow = load_workflow(path)
    return ServiceConfig.from_workflow(workflow, path)


def apply_runtime_config(
    config: ServiceConfig,
    *,
    tracker: LinearTracker,
    runner: AgentRunner,
    orchestrator: Orchestrator,
) -> None:
    if hasattr(tracker, "update_config"):
        tracker.update_config(config.tracker)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    orchestrator.config = config
    orchestrator.workspace_manager = workspace_manager
    runner.config = config
    runner.workspace_manager = workspace_manager
    runner.codex_client.config = config.codex
    if not config.acceptance.enabled:
        orchestrator.acceptance_runner = None
    elif isinstance(orchestrator.acceptance_runner, CodexAcceptanceRunner):
        orchestrator.acceptance_runner.config = config
        orchestrator.acceptance_runner.codex_client.config = config.codex
    elif isinstance(orchestrator.acceptance_runner, SmokeAcceptanceRunner):
        orchestrator.acceptance_runner = build_acceptance_runner(config)
    elif orchestrator.acceptance_runner is None:
        orchestrator.acceptance_runner = build_acceptance_runner(config)


def build_acceptance_runner(config: ServiceConfig) -> CodexAcceptanceRunner | SmokeAcceptanceRunner | None:
    if not config.acceptance.enabled:
        return None
    if config.acceptance.gate_planner_mode == "smoke":
        return SmokeAcceptanceRunner(config)
    return CodexAcceptanceRunner(config)


def persistence_store_from_config(config: ServiceConfig) -> PersistenceStore | None:
    if config.persistence.path is None:
        return None
    return PersistenceStore(config.persistence.path)


async def run_daemon(config: ServiceConfig, *, once: bool = False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config.validate_for_dispatch()
    validate_tracker_config(config.tracker)
    tracker = create_tracker(config.tracker)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    runner = AgentRunner(config, workspace_manager, tracker=tracker)
    orchestrator = Orchestrator(
        config,
        tracker,
        runner,
        workspace_manager=workspace_manager,
        persistence_store=persistence_store_from_config(config),
        acceptance_runner=build_acceptance_runner(config),
    )
    orchestrator.load_persisted_state()
    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)
    while True:
        try:
            await orchestrator.tick()
        except Exception as exc:
            logging.exception("performer_tick failed reason=%s", exc)
        if once:
            await orchestrator.wait_for_idle()
            return
        await asyncio.sleep(config.polling.interval_ms / 1000)


async def run_dispatch_issue(workflow_path: Path, issue_id: str) -> dict[str, object]:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    orchestrator = _build_one_shot_orchestrator(workflow_path)
    orchestrator.load_persisted_state()
    await orchestrator.startup_terminal_workspace_cleanup(orchestrator.workspace_manager)
    result = await orchestrator.dispatch_issue_by_id(issue_id)
    await orchestrator.wait_for_idle()
    return result


async def run_phase_advance(
    workflow_path: Path,
    advance_request_path: Path,
    phase_result_path: Path,
) -> PhaseAdvanceResult:
    try:
        request_payload = json.loads(advance_request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read phase advance request: {advance_request_path}") from exc
    if not isinstance(request_payload, dict):
        raise RuntimeError(f"phase advance request must be a JSON object: {advance_request_path}")
    request = PhaseAdvanceRequest.from_dict(request_payload)
    orchestrator = _build_one_shot_orchestrator(workflow_path)
    orchestrator.load_persisted_state()
    await orchestrator.startup_terminal_workspace_cleanup(orchestrator.workspace_manager)
    if request.human_response:
        process_response = getattr(orchestrator, "process_managed_human_response", None)
        if callable(process_response):
            await process_response(request.issue_id, request.human_response)
    dispatch_result = await orchestrator.dispatch_issue_by_id(request.issue_id)
    await orchestrator.wait_for_idle()
    result = _phase_result_from_state(request, dispatch_result, getattr(orchestrator, "state", None), workflow_path=workflow_path)
    _write_json_atomic(phase_result_path, result.to_dict())
    return result


async def run_reloading_daemon(workflow_path: Path, *, once: bool = False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    reloader = WorkflowReloader(workflow_path)
    config = reloader.current()
    validate_tracker_config(config.tracker)
    tracker = create_tracker(config.tracker)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    runner = AgentRunner(config, workspace_manager, tracker=tracker)
    orchestrator = Orchestrator(
        config,
        tracker,
        runner,
        workspace_manager=workspace_manager,
        persistence_store=persistence_store_from_config(config),
        acceptance_runner=build_acceptance_runner(config),
    )
    orchestrator.load_persisted_state()
    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)
    while True:
        config = reloader.current()
        apply_runtime_config(config, tracker=tracker, runner=runner, orchestrator=orchestrator)
        try:
            await orchestrator.tick()
        except Exception as exc:
            logging.exception("performer_tick failed reason=%s", exc)
        if once:
            await orchestrator.wait_for_idle()
            return
        await asyncio.sleep(config.polling.interval_ms / 1000)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Performer Linear/Codex daemon.")
    parser.add_argument("workflow", nargs="?", help="Path to WORKFLOW.md")
    parser.add_argument("--once", action="store_true", help="Run one poll cycle and exit after workers finish.")
    parser.add_argument("--dispatch-issue-id", default=None, help="Run one event-driven dispatch for a Linear issue id.")
    parser.add_argument("--advance-request-path", default=None, help="Read one managed phase advance request JSON file.")
    parser.add_argument("--phase-result-path", default=None, help="Write one managed phase result JSON file.")
    return parser.parse_args(argv)


def _build_one_shot_orchestrator(workflow_path: Path) -> Orchestrator:
    config = build_config_from_path(workflow_path)
    validate_tracker_config(config.tracker)
    tracker = create_tracker(config.tracker)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    runner = AgentRunner(config, workspace_manager, tracker=tracker)
    orchestrator = Orchestrator(
        config,
        tracker,
        runner,
        workspace_manager=workspace_manager,
        persistence_store=persistence_store_from_config(config),
        acceptance_runner=build_acceptance_runner(config),
    )
    if not hasattr(orchestrator, "workspace_manager"):
        orchestrator.workspace_manager = workspace_manager
    return orchestrator


def _phase_result_from_dispatch(
    request: PhaseAdvanceRequest,
    dispatch_result: dict[str, object],
    *,
    workflow_path: Path,
) -> PhaseAdvanceResult:
    status = str(dispatch_result.get("status") or "")
    reason = str(dispatch_result.get("reason") or dispatch_result.get("runtime_phase") or status or "unknown")
    issue_identifier = str(dispatch_result.get("issue_identifier") or request.issue_identifier or request.issue_id)
    if status == "completed":
        next_phase = RunPhase.DONE
        retry_delay_seconds = None
    elif status in {"failed", "skipped"}:
        next_phase = RunPhase.FAILED
        retry_delay_seconds = None
    elif status == "awaiting_human":
        next_phase = RunPhase.AWAITING_HUMAN
        retry_delay_seconds = None
    elif status == "reviewing":
        next_phase = RunPhase.REVIEWING
        retry_delay_seconds = None
    elif status == "reworking":
        next_phase = RunPhase.REWORKING
        retry_delay_seconds = None
    else:
        next_phase = RunPhase.QUEUED
        retry_delay_seconds = 0
    workspace_root = str(request.workspace_context.get("workspace_root") or "")
    workspace_path = str(dispatch_result.get("workspace_path") or "")
    if not workspace_path and workspace_root:
        workspace_path = str(Path(workspace_root) / issue_identifier)
    ops_snapshot_path = str(dispatch_result.get("ops_snapshot_path") or "")
    if not ops_snapshot_path:
        configured = request.workspace_context.get("ops_snapshot_path")
        if configured:
            ops_snapshot_path = str(configured)
        else:
            ops_snapshot_path = str((workflow_path.parent / "state" / "ops.json").resolve())
    human_action = dispatch_result.get("human_action")
    return PhaseAdvanceResult(
        run_id=request.run_id,
        issue_id=str(dispatch_result.get("issue_id") or request.issue_id),
        next_phase=next_phase,
        status=status or "failed",
        reason=reason,
        retry_delay_seconds=retry_delay_seconds,
        human_action=human_action if isinstance(human_action, dict) else None,
        workspace_path=workspace_path or None,
        ops_snapshot_path=ops_snapshot_path or None,
    )


def _phase_result_from_state(
    request: PhaseAdvanceRequest,
    dispatch_result: dict[str, object],
    state: Any,
    *,
    workflow_path: Path,
) -> PhaseAdvanceResult:
    if state is None:
        return _phase_result_from_dispatch(request, dispatch_result, workflow_path=workflow_path)
    issue_id = str(dispatch_result.get("issue_id") or request.issue_id)
    completed = getattr(state, "completed", set())
    if issue_id in completed:
        base = _phase_result_from_dispatch(
            request,
            {"status": "completed", "issue_id": issue_id, "reason": "completed_by_runtime", **dispatch_result},
            workflow_path=workflow_path,
        )
        return PhaseAdvanceResult(
            run_id=base.run_id,
            issue_id=base.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason=base.reason or "completed_by_runtime",
            workspace_path=base.workspace_path,
            ops_snapshot_path=base.ops_snapshot_path,
        )
    interventions = getattr(state, "human_interventions", {})
    if issue_id in interventions:
        intervention = interventions[issue_id]
        base = _phase_result_from_dispatch(request, dispatch_result, workflow_path=workflow_path)
        return PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=issue_id,
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason=getattr(intervention, "error", None) or "awaiting human action",
            human_action={
                "child_issue_id": getattr(intervention, "child_issue_id", None),
                "child_identifier": getattr(intervention, "child_identifier", None),
                "child_url": getattr(intervention, "child_url", None),
                "kind": getattr(intervention, "kind", None),
                "questions": list(getattr(intervention, "questions", []) or []),
            },
            workspace_path=base.workspace_path,
            ops_snapshot_path=base.ops_snapshot_path,
        )
    retries = getattr(state, "retry_attempts", {})
    continuations = getattr(state, "continuations", {})
    pending = retries.get(issue_id) if isinstance(retries, dict) else None
    retry_status = "retry"
    if pending is None and isinstance(continuations, dict):
        pending = continuations.get(issue_id)
        retry_status = "accepted"
    if pending is not None:
        base = _phase_result_from_dispatch(request, dispatch_result, workflow_path=workflow_path)
        return PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=issue_id,
            next_phase=RunPhase.QUEUED,
            status=retry_status,
            reason=getattr(pending, "error", None) or getattr(pending, "last_message", None) or base.reason,
            retry_delay_seconds=_retry_delay_seconds(pending),
            workspace_path=base.workspace_path,
            ops_snapshot_path=base.ops_snapshot_path,
        )
    blocked = getattr(state, "blocked", {})
    if isinstance(blocked, dict) and issue_id in blocked:
        entry = blocked[issue_id]
        base = _phase_result_from_dispatch(request, dispatch_result, workflow_path=workflow_path)
        return PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=issue_id,
            next_phase=RunPhase.FAILED,
            status="failed",
            reason=getattr(entry, "error", None) or "blocked",
            workspace_path=base.workspace_path,
            ops_snapshot_path=base.ops_snapshot_path,
        )
    return _phase_result_from_dispatch(request, dispatch_result, workflow_path=workflow_path)


def _retry_delay_seconds(entry: Any) -> int:
    due_at = getattr(entry, "due_at", None)
    if not isinstance(due_at, datetime):
        return 0
    return max(int((due_at - datetime.now(timezone.utc)).total_seconds()), 0)


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    path = Path(args.workflow).resolve() if args.workflow else default_workflow_path().resolve()
    try:
        if args.advance_request_path or args.phase_result_path:
            if not args.advance_request_path or not args.phase_result_path:
                raise RuntimeError("--advance-request-path and --phase-result-path must be provided together")
            asyncio.run(
                run_phase_advance(
                    path,
                    Path(args.advance_request_path).resolve(),
                    Path(args.phase_result_path).resolve(),
                )
            )
        elif args.dispatch_issue_id:
            asyncio.run(run_dispatch_issue(path, args.dispatch_issue_id))
        else:
            asyncio.run(run_reloading_daemon(path, once=args.once))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
