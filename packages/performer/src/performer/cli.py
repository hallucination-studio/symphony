from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

from .acceptance import CodexAcceptanceRunner
from performer_api.config import ServiceConfig, load_env_file
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
    elif orchestrator.acceptance_runner is None:
        orchestrator.acceptance_runner = build_acceptance_runner(config)


def build_acceptance_runner(config: ServiceConfig) -> CodexAcceptanceRunner | None:
    if not config.acceptance.enabled:
        return None
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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    path = Path(args.workflow).resolve() if args.workflow else default_workflow_path().resolve()
    try:
        asyncio.run(run_reloading_daemon(path, once=args.once))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
