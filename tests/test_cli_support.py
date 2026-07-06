from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from performer import cli
from conductor import conductor_cli
from podium.cli import parse_args as parse_podium_args
from performer.cli import (
    apply_runtime_config,
    build_config_from_path,
    build_acceptance_runner,
    default_workflow_path,
    persistence_store_from_config,
    parse_args,
)
from conductor.conductor_cli import parse_args as parse_conductor_args
from performer_api.config import (
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    AcceptanceConfig,
    WorkspaceConfig,
)
from performer_api.phase import PhaseAdvanceRequest, RunPhase
from performer_api.models import HumanInterventionEntry, RetryEntry, utc_now
from performer.acceptance import CodexAcceptanceRunner, SmokeAcceptanceRunner
from performer.linear import LinearTracker
from performer.orchestrator import Orchestrator
from performer.runner import AgentRunner
from performer.workspace import WorkspaceManager



























def make_service_config(tmp_path: Path, *, project_slug: str, api_key: str, workspace: str, command: str) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug=project_slug,
            api_key=api_key,
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path / workspace),
        hooks=HooksConfig(timeout_ms=1234),
        agent=AgentConfig(max_turns=3),
        codex=CodexConfig(command=command),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )
