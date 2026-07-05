from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

from .acceptance import CodexAcceptanceRunner, SmokeAcceptanceRunner
from .codex_client import CodexError
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
    orchestrator_config = getattr(orchestrator, "config", None)
    if orchestrator_config is None:
        orchestrator_config = build_config_from_path(workflow_path)
    phase_timeout_seconds = _phase_advance_timeout_seconds(orchestrator_config)
    orchestrator.load_persisted_state()
    await orchestrator.startup_terminal_workspace_cleanup(orchestrator.workspace_manager)
    try:
        result = await asyncio.wait_for(
            _advance_and_wait_for_idle(orchestrator, request),
            timeout=phase_timeout_seconds,
        )
    except CodexError as exc:
        if exc.code == "codex_init_failed":
            result = PhaseAdvanceResult(
                run_id=request.run_id,
                issue_id=request.issue_id,
                next_phase=RunPhase.QUEUED,
                status="init_failed",
                reason="codex_init_failed",
                retry_delay_seconds=5,
            )
        elif exc.code in {"timeout", "request_timeout", "sdk_transport_error", "response_error", "rate_limit", "connection_error"}:
            result = PhaseAdvanceResult(
                run_id=request.run_id,
                issue_id=request.issue_id,
                next_phase=RunPhase.QUEUED,
                status="retry",
                reason=exc.code,
                retry_delay_seconds=5,
            )
        else:
            raise
    except (asyncio.TimeoutError, TimeoutError):
        result = PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=request.issue_id,
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason="turn_timeout",
            retry_delay_seconds=5,
        )
    _write_json_atomic(phase_result_path, result.to_dict())
    return result


async def _advance_and_wait_for_idle(orchestrator: Orchestrator, request: PhaseAdvanceRequest) -> PhaseAdvanceResult:
    result = await orchestrator.advance(request)
    await orchestrator.wait_for_idle()
    return result


def _phase_advance_timeout_seconds(config: ServiceConfig) -> float | None:
    hard_turn_timeout_ms = max(0, int(config.codex.hard_turn_timeout_ms or 0))
    read_timeout_ms = max(0, int(config.codex.read_timeout_ms or 0))
    if hard_turn_timeout_ms <= 0 and read_timeout_ms <= 0:
        return None
    return (hard_turn_timeout_ms + read_timeout_ms + 5_000) / 1000


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
            os._exit(0)
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
