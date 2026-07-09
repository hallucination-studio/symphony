from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from performer_api.pipeline import RuntimeMode

from . import mode_common as _mode_common
from .mode_common import CodexSdkClient
from .execute_mode import (
    _collect_git_verification_input,
    _execute_branch_name,
    _execute_repository_path,
    _execute_workspace_path,
    _executor_prompt,
    _failed_execute_result,
    _git_command_succeeds,
    _materialize_execute_workspace,
    _remove_generated_verification_caches,
    _run_execute_mode,
)
from .mode_common import (
    _attempt_event_printer,
    _emit_runtime_wait_probe_if_requested,
    _env_bool,
    _env_config_overrides,
    _env_float,
    _env_int,
    _env_sandbox,
    _env_str,
    _file_sha256,
    _fencing_fields,
    _git,
    _managed_codex_backend,
    _optional_payload_str,
    _payload_kind,
    _run,
    _sanitize_error,
    _thread_state_workspace_path,
)
from .plan_mode import (
    PLAN_RESULT_SCHEMA,
    _failed_plan_result,
    _planner_prompt,
    _planner_prompt_payload,
    _planner_retry_prompt,
    _planner_structured_result,
    _planner_workspace_path,
    _positive_int,
    _proposal_blocks,
    _proposal_from_model_payload,
    _run_plan_mode,
)
from .verify_mode import (
    _PatchVerificationResult,
    _commit_verify_workspace,
    _failed_gate_verify_result,
    _failed_verify_result,
    _forced_first_verify_failure_reason,
    _gate_command_failure_reason,
    _run_gate_commands,
    _run_verify_mode,
    _single_line_tail,
    _verification_command_cwd,
    _verification_command_env,
    _verify_artifact_hashes,
    _verify_patch_hash,
)


async def run_mode_attempt(
    mode: RuntimeMode,
    attempt_request_path: Path,
    attempt_result_path: Path,
    *,
    agent_backend: Any | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(attempt_request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read {mode.value} attempt request: {attempt_request_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{mode.value} attempt request must be a JSON object: {attempt_request_path}")
    if mode is RuntimeMode.PLAN:
        result = await _run_plan_mode(payload, agent_backend=agent_backend)
    elif mode is RuntimeMode.EXECUTE:
        _mode_common.CodexSdkClient = CodexSdkClient
        result = await _run_execute_mode(payload, agent_backend=agent_backend)
    elif mode is RuntimeMode.VERIFY:
        result = _run_verify_mode(payload)
    else:
        raise RuntimeError(f"unsupported runtime mode: {mode.value}")
    _write_json_atomic(attempt_result_path, result)
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one managed Performer plan/execute/verify attempt.")
    parser.add_argument("--mode", choices=[mode.value for mode in RuntimeMode], default=None, help="Run one managed plan/execute/verify attempt.")
    parser.add_argument("--attempt-request-path", default=None, help="Read one managed mode attempt request JSON file.")
    parser.add_argument("--attempt-result-path", default=None, help="Write one managed mode attempt result JSON file.")
    args = parser.parse_args(argv)
    if not args.mode or not args.attempt_request_path or not args.attempt_result_path:
        parser.error("--mode, --attempt-request-path, and --attempt-result-path are required")
    return args


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(
            run_mode_attempt(
                RuntimeMode(args.mode),
                Path(args.attempt_request_path).resolve(),
                Path(args.attempt_result_path).resolve(),
            )
        )
        os._exit(0)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
