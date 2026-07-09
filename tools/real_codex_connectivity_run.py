from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from performer.codex_client import CodexError, CodexSdkClient
from performer_api.config import CodexConfig
from real_codex_connectivity_core import (
    _planner_shape_valid,
    classify_connectivity,
    extract_probe_structured_result,
    probe_spec,
    sanitize_text,
    sanitize_value,
    scenario_passed,
    summarize_events,
)


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []
    config_overrides = tuple(args.config_override or ())
    client = CodexSdkClient(_codex_config(args, config_overrides))
    summary = _initial_summary(args, workspace, config_overrides)
    old_codex_home = _set_codex_home(args.codex_home)
    try:
        await _run_codex_turn(client, workspace, args.probe_kind, events, summary)
    except CodexError as exc:
        summary.update({"outcome": "codex_error", "error_code": exc.code, "error": sanitize_text(str(exc)), "http_status": exc.http_status})
    except Exception as exc:
        summary.update({"outcome": "unexpected_error", "error_code": exc.__class__.__name__, "error": sanitize_text(str(exc))})
    finally:
        _restore_codex_home(old_codex_home)
    summary.update(summarize_events(events))
    summary["connectivity_status"] = classify_connectivity(summary)
    summary["pass"] = scenario_passed(summary, args.expected)
    _write_summary(args.out, summary)
    return summary


def _codex_config(args: argparse.Namespace, config_overrides: tuple[str, ...]) -> CodexConfig:
    return CodexConfig(
        model=args.model,
        sdk_codex_bin=args.sdk_codex_bin,
        sandbox=args.sandbox,
        config_overrides=config_overrides,
        read_timeout_ms=args.timeout_ms,
        turn_timeout_ms=args.timeout_ms,
        hard_turn_timeout_ms=args.timeout_ms,
        init_max_attempts=args.init_max_attempts,
        init_backoff_ms=args.init_backoff_ms,
        init_backoff_max_ms=args.init_backoff_max_ms,
        overload_max_attempts=args.overload_max_attempts,
        overload_initial_delay_ms=args.overload_initial_delay_ms,
        overload_max_delay_ms=args.overload_max_delay_ms,
    )


def _initial_summary(args: argparse.Namespace, workspace: Path, config_overrides: tuple[str, ...]) -> dict[str, Any]:
    return {
        "workspace": str(workspace),
        "expected": args.expected,
        "probe_kind": args.probe_kind,
        "codex_home_configured": bool(args.codex_home),
        "config_overrides": sanitize_value(list(config_overrides)),
    }


def _set_codex_home(codex_home: Path | None) -> str | None:
    old_codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        os.environ["CODEX_HOME"] = str(codex_home.resolve())
    return old_codex_home


def _restore_codex_home(old_codex_home: str | None) -> None:
    if old_codex_home is None:
        os.environ.pop("CODEX_HOME", None)
    else:
        os.environ["CODEX_HOME"] = old_codex_home


async def _run_codex_turn(
    client: CodexSdkClient,
    workspace: Path,
    probe_kind: str,
    events: list[dict[str, Any]],
    summary: dict[str, Any],
) -> None:
    spec = probe_spec(probe_kind)
    result = await client.run_session(
        workspace,
        spec.prompt,
        "symphony-codex-connectivity-probe",
        on_event=events.append,
        output_schema=spec.schema,
    )
    structured = extract_probe_structured_result(result)
    final_response = result.final_response if isinstance(result.final_response, str) else ""
    summary.update(
        {
            "outcome": "success",
            "thread_id": result.thread_id,
            "turn_id": result.turn_id,
            "structured_present": bool(structured),
            "structured_status": structured.get("status"),
            "structured_probe_kind": structured.get("probe_kind"),
            "planner_shape_valid": _planner_shape_valid(structured),
            "final_response_excerpt": sanitize_text(final_response[:1000]),
        }
    )


def _write_summary(out: Path | None, summary: dict[str, Any]) -> None:
    if not out:
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
