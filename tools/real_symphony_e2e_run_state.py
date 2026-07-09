from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence, ManagedProcess


@dataclass
class E2ERunState:
    args: argparse.Namespace
    token: str
    agent_app_user_id: str
    root: Path
    evidence: Evidence
    env: dict[str, str]
    bin_dir: Path
    run_id: str
    pipeline_scenario: str
    permission_approval_probe: bool
    workspace_id: str
    fixture: Path
    podium_port: int
    conductor_port: int
    data_root: Path
    staged_codex_home: Path
    processes: list[ManagedProcess] = field(default_factory=list)
    postgres_container: Any = None
    enrolled_runtime: dict[str, Any] = field(default_factory=dict)
    runtime_config: dict[str, Any] = field(default_factory=dict)
    linear: dict[str, Any] = field(default_factory=dict)
    instance: dict[str, Any] = field(default_factory=dict)
    instance_id: str = ""
    lowered_policy_task: asyncio.Task[dict[str, Any]] | None = None
    run_result: dict[str, Any] = field(default_factory=dict)
