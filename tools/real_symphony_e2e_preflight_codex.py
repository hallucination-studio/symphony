from __future__ import annotations

import argparse
import os
from pathlib import Path

from real_codex_connectivity_probe import run_probe as run_real_codex_connectivity_probe
from real_symphony_e2e_common import Evidence


async def run_codex_connectivity_probe(
    *,
    evidence: Evidence,
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
) -> bool:
    out = root / "codex-connectivity-probe.json"
    summary = await run_real_codex_connectivity_probe(
        _probe_args(root, staged_codex_home, args, out=out, probe_kind="minimal", timeout_attr="codex_connectivity_timeout_ms", timeout_default=45_000)
    )
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
    summary = await run_real_codex_connectivity_probe(
        _probe_args(root, staged_codex_home, args, out=out, probe_kind="planner-shaped", timeout_attr="codex_planner_shaped_timeout_ms", timeout_default=120_000)
    )
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


def _probe_args(
    root: Path,
    staged_codex_home: Path,
    args: argparse.Namespace,
    *,
    out: Path,
    probe_kind: str,
    timeout_attr: str,
    timeout_default: int,
) -> argparse.Namespace:
    return argparse.Namespace(
        workspace=root / f"codex-{probe_kind}-workspace",
        codex_home=staged_codex_home,
        out=out,
        probe_kind=probe_kind,
        expected="connected",
        model=os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or None,
        sdk_codex_bin=getattr(args, "sdk_codex_bin", None),
        sandbox=None,
        config_override=getattr(args, "config_override", None),
        timeout_ms=getattr(args, timeout_attr, timeout_default),
        init_max_attempts=getattr(args, "init_max_attempts", None) or 2,
        init_backoff_ms=getattr(args, "init_backoff_ms", None) or 500,
        init_backoff_max_ms=getattr(args, "init_backoff_max_ms", None) or 2_000,
        overload_max_attempts=getattr(args, "overload_max_attempts", None) or 2,
        overload_initial_delay_ms=getattr(args, "overload_initial_delay_ms", None) or 250,
        overload_max_delay_ms=getattr(args, "overload_max_delay_ms", None) or 2_000,
    )
