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

import asyncpg

from performer_api.config import sanitize_codex_config_template
from real_codex_connectivity_probe import run_probe as run_real_codex_connectivity_probe
from real_symphony_e2e_common import Evidence, allocate_port, utc_now


CODEX_HOME_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
CODEX_HOME_SEED_ENV = "SYMPHONY_E2E_CODEX_HOME_SEED"
LINEAR_AGENT_OAUTH_SCOPE = "read,write,app:assignable,app:mentionable"
DEFAULT_E2E_HARD_TURN_TIMEOUT_MS = 900_000
E2E_POSTGRES_IMAGE = "postgres:16-alpine"

def build_runtime_config_payload(
    *,
    runtime_group_id: str,
    version: int,
    model: str | None = None,
    codex_home_source: str | None = None,
    codex_settings: dict[str, Any] | None = None,
    pipeline_scenario: str = "basic",
) -> dict[str, Any]:
    settings = dict(codex_settings or {})
    model_name = (model or os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or "").strip()
    if model_name:
        settings["model"] = model_name
    if codex_home_source:
        settings["codex_home_source"] = codex_home_source
    by_mode = {"plan": 1, "execute": 1, "verify": 1}
    if pipeline_scenario in {"parallel", "integration-conflict", "overall-dod"}:
        by_mode["execute"] = 2
    execute_settings = dict(settings)
    if pipeline_scenario in {"runtime-wait", "overall-dod"}:
        execute_settings["emit_runtime_wait_probe"] = True
        execute_settings["runtime_wait_probe_seconds"] = 90
    verify_settings: dict[str, Any] = {}
    if pipeline_scenario in {"replan", "overall-dod"}:
        verify_settings["force_first_verify_failure_for_replan"] = True
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "scheduler_policy": {
            "policy_id": f"policy-{runtime_group_id}",
            "version": version,
            "effective_at": utc_now(),
            "capacity": {"global": 3, "by_mode": by_mode},
            "max_rework_attempts": 1,
        },
        "profiles": {
            "plan": {
                "name": "codex-plan",
                "backend": "codex",
                "mode": "plan",
                "settings": dict(settings),
            },
            "execute": {
                "name": "codex-execute",
                "backend": "codex",
                "mode": "execute",
                "settings": execute_settings,
            },
            "verify": {
                "name": "local-verifier",
                "backend": "local-verifier",
                "mode": "verify",
                "settings": verify_settings,
            },
        },
    }


async def start_e2e_postgres_if_needed(root: Path, env: dict[str, str], evidence: Evidence) -> str | None:
    if env.get("PODIUM_DATABASE_URL", "").strip():
        evidence.check("podium-db:external-url-configured", True)
        return None
    port = allocate_port()
    container_name = f"symphony-e2e-pg-{uuid.uuid4().hex[:12]}"
    password = uuid.uuid4().hex
    command = [
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        container_name,
        "-e",
        "POSTGRES_USER=podium",
        "-e",
        f"POSTGRES_PASSWORD={password}",
        "-e",
        "POSTGRES_DB=podium",
        "-p",
        f"127.0.0.1:{port}:5432",
        E2E_POSTGRES_IMAGE,
    ]
    result = subprocess.run(command, text=True, capture_output=True, timeout=60)
    (root / "postgres-container.log").write_text(
        json.dumps(
            {
                "container_name": container_name,
                "port": port,
                "returncode": result.returncode,
                "stdout_tail": result.stdout[-500:],
                "stderr_tail": result.stderr[-500:],
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    evidence.artifact("postgres-container", root / "postgres-container.log")
    evidence.check(
        "podium-db:ephemeral-postgres-started",
        result.returncode == 0,
        container_name=container_name,
        port=port,
        image=E2E_POSTGRES_IMAGE,
        stderr_tail=result.stderr[-500:],
    )
    if result.returncode != 0:
        raise RuntimeError("ephemeral PostgreSQL container failed to start")
    database_url = f"postgresql://podium:{password}@127.0.0.1:{port}/podium"
    try:
        deadline = time.monotonic() + 30
        ready = False
        last_stderr = ""
        while time.monotonic() < deadline:
            probe = subprocess.run(
                ["docker", "exec", container_name, "pg_isready", "-U", "podium", "-d", "podium"],
                text=True,
                capture_output=True,
                timeout=10,
            )
            if probe.returncode == 0:
                try:
                    connection = await asyncpg.connect(database_url)
                    await connection.close()
                    ready = True
                    break
                except Exception as exc:
                    last_stderr = f"{exc.__class__.__name__}: {exc}"
            else:
                last_stderr = probe.stderr[-500:] or probe.stdout[-500:]
            await asyncio.sleep(0.5)
        evidence.check(
            "podium-db:ephemeral-postgres-ready",
            ready,
            container_name=container_name,
            port=port,
            stderr_tail=last_stderr,
        )
        if not ready:
            raise RuntimeError("ephemeral PostgreSQL container did not become ready")
    except Exception:
        stop_e2e_postgres(container_name)
        raise
    env["PODIUM_DATABASE_URL"] = database_url
    return container_name


def stop_e2e_postgres(container_name: str | None) -> None:
    if not container_name:
        return
    subprocess.run(["docker", "rm", "-f", container_name], text=True, capture_output=True, timeout=30)


def e2e_codex_home_seed_source() -> Path:
    raw_source = os.environ.get(CODEX_HOME_SEED_ENV, "").strip()
    if not raw_source:
        raise RuntimeError(
            f"{CODEX_HOME_SEED_ENV} is required and must point to a fixed copied Codex config seed. "
            "Do not point real-run E2E at the default user .codex directory."
        )
    return Path(raw_source)


def stage_codex_home_seed(*, source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve()
    if source.name == ".codex":
        raise RuntimeError(f"Codex config source must be a fixed copied seed, not the default user .codex directory: {source}")
    if not source.is_dir():
        raise RuntimeError(f"Codex config source is not a directory: {source}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for relative in CODEX_HOME_SEED_FILES:
        source_path = source / relative
        if source_path.is_file():
            destination_path = destination / relative
            if relative == "config.toml":
                destination_path.write_text(
                    sanitize_codex_config_template(source_path.read_text(encoding="utf-8")),
                    encoding="utf-8",
                )
            else:
                shutil.copy2(source_path, destination_path)
    if not (destination / "config.toml").is_file():
        raise RuntimeError(f"Codex config source is missing config.toml: {source}")
    if not (destination / "auth.json").is_file():
        raise RuntimeError(f"Codex config source is missing auth.json: {source}")
    return destination


async def run_codex_connectivity_probe(
    *,
    evidence: Evidence,
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
) -> bool:
    out = root / "codex-connectivity-probe.json"
    probe_args = argparse.Namespace(
        workspace=root / "codex-connectivity-workspace",
        codex_home=staged_codex_home,
        out=out,
        probe_kind="minimal",
        expected="connected",
        model=os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or None,
        sdk_codex_bin=getattr(args, "sdk_codex_bin", None),
        sandbox=None,
        config_override=getattr(args, "config_override", None),
        timeout_ms=getattr(args, "codex_connectivity_timeout_ms", 45_000),
        init_max_attempts=getattr(args, "init_max_attempts", None) or 2,
        init_backoff_ms=getattr(args, "init_backoff_ms", None) or 500,
        init_backoff_max_ms=getattr(args, "init_backoff_max_ms", None) or 2_000,
        overload_max_attempts=getattr(args, "overload_max_attempts", None) or 2,
        overload_initial_delay_ms=getattr(args, "overload_initial_delay_ms", None) or 250,
        overload_max_delay_ms=getattr(args, "overload_max_delay_ms", None) or 2_000,
    )
    summary = await run_real_codex_connectivity_probe(probe_args)
    evidence.artifact("codex_connectivity_probe", out)
    status = str(summary.get("connectivity_status") or "unknown")
    evidence.check(
        "codex-connectivity:connected",
        status == "connected",
        status=status,
        outcome=summary.get("outcome"),
        error_code=summary.get("error_code"),
        http_status=summary.get("http_status"),
        output=str(out),
    )
    return status == "connected"


async def run_codex_planner_shaped_probe(
    *,
    evidence: Evidence,
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
) -> bool:
    out = root / "codex-planner-shaped-probe.json"
    probe_args = argparse.Namespace(
        workspace=root / "codex-planner-shaped-workspace",
        codex_home=staged_codex_home,
        out=out,
        probe_kind="planner-shaped",
        expected="connected",
        model=os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or None,
        sdk_codex_bin=getattr(args, "sdk_codex_bin", None),
        sandbox=None,
        config_override=getattr(args, "config_override", None),
        timeout_ms=getattr(args, "codex_planner_shaped_timeout_ms", 120_000),
        init_max_attempts=getattr(args, "init_max_attempts", None) or 2,
        init_backoff_ms=getattr(args, "init_backoff_ms", None) or 500,
        init_backoff_max_ms=getattr(args, "init_backoff_max_ms", None) or 2_000,
        overload_max_attempts=getattr(args, "overload_max_attempts", None) or 2,
        overload_initial_delay_ms=getattr(args, "overload_initial_delay_ms", None) or 250,
        overload_max_delay_ms=getattr(args, "overload_max_delay_ms", None) or 2_000,
    )
    summary = await run_real_codex_connectivity_probe(probe_args)
    evidence.artifact("codex_planner_shaped_probe", out)
    status = str(summary.get("connectivity_status") or "unknown")
    evidence.check(
        "codex-connectivity:planner-shaped",
        status == "connected",
        status=status,
        outcome=summary.get("outcome"),
        error_code=summary.get("error_code"),
        http_status=summary.get("http_status"),
        planner_shape_valid=summary.get("planner_shape_valid"),
        structured_present=summary.get("structured_present"),
        output=str(out),
    )
    return status == "connected"


def _codex_settings_from_args(args: argparse.Namespace) -> dict[str, Any]:
    settings: dict[str, Any] = {"hard_turn_timeout_ms": DEFAULT_E2E_HARD_TURN_TIMEOUT_MS}
    for arg_name in (
        "sdk_codex_bin",
        "init_max_attempts",
        "init_backoff_ms",
        "init_backoff_max_ms",
        "read_timeout_ms",
        "hard_turn_timeout_ms",
        "overload_max_attempts",
        "overload_initial_delay_ms",
        "overload_max_delay_ms",
    ):
        value = getattr(args, arg_name, None)
        if value is not None:
            settings[arg_name] = value
    config_overrides = getattr(args, "config_override", None)
    if config_overrides:
        settings["config_overrides"] = list(config_overrides)
    return settings


APPENDIX_PYTEST_HARDENING_PROBES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "appendix:s1-terminal-attempt-immutable",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s1-superseded-revision-refused",
        ("tests/conductor_pipeline/test_replanning.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s2-malformed-proposal-refused",
        (
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_cycles_missing_gates_and_incomplete_rubrics",
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_bad_or_unfrozen_gate_hashes",
        ),
    ),
    (
        "appendix:s2-gate-post-freeze-immutable",
        (
            "tests/conductor_pipeline/test_store_and_runtime_env.py::test_execute_attempt_cannot_start_without_frozen_gate_snapshot",
            "tests/conductor_pipeline/test_store_and_runtime_env.py::test_verify_attempt_cannot_start_without_frozen_gate_snapshot",
        ),
    ),
    (
        "appendix:s2-linear-idempotent-rerun",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_pipeline_coordinator_resumes_existing_root_planning_node_for_duplicate_dispatch",),
    ),
    (
        "appendix:s3-verifier-mutation-detection",
        (
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_verification_worktree",
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_tracked_state",
        ),
    ),
    (
        "appendix:s3-applied-tree-mismatch-rejected",
        ("tests/test_performer_modes.py::test_verify_mode_rejects_expected_result_tree_mismatch",),
    ),
    (
        "appendix:s3-expired-fencing-refused",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s4-superseded-revision-fenced",
        ("tests/conductor_pipeline/test_replanning.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s4-invalid-replan-escalates",
        ("tests/conductor_pipeline/test_replanning.py::test_replanning_validation_failure_escalates_to_human_without_failed_node",),
    ),
    (
        "appendix:linear-legitimate-blocks-edits-ingested",
        ("tests/conductor_pipeline/test_linear_projection.py::test_pipeline_linear_projector_ingests_human_added_blocks_as_new_graph_revision",),
    ),
)

