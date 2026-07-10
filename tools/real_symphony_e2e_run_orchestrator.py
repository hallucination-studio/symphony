from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from real_symphony_e2e_artifacts import _handle_managed_run_runtime_blocker
from real_symphony_e2e_common import Evidence, utc_now
from real_symphony_e2e_early_exit import (
    archive_early_exit_artifacts,
    record_e2e_exception,
    record_unhandled_e2e_exception,
)
from real_symphony_e2e_preflight import (
    cleanup_staged_codex_home,
    scrub_e2e_runtime_credentials,
    stop_e2e_postgres,
)
from real_symphony_e2e_run_final import (
    archive_tree_and_runtime_artifacts,
    run_post_wait_checks,
    run_service_recovery_and_cleanup_checks,
)
from real_symphony_e2e_run_runtime import restart_conductor_and_push_runtime_config, wait_for_dispatch_and_run
from real_symphony_e2e_run_setup import (
    build_initial_state,
    create_issue_and_instance,
    prepare_fixture_and_cli,
    run_connectivity_preflight,
    start_conductor_and_configure,
    start_podium_and_enroll,
)


async def run(args: argparse.Namespace) -> dict[str, Any]:
    try:
        state = await build_initial_state(args)
    except Exception as exc:
        return _finish_bootstrap_failure(args, exc)
    try:
        if await run_connectivity_preflight(state):
            prepare_fixture_and_cli(state)
            await start_podium_and_enroll(state)
            await start_conductor_and_configure(state)
            await create_issue_and_instance(state)
            await restart_conductor_and_push_runtime_config(state)
            await wait_for_dispatch_and_run(state)
            blocked = _handle_managed_run_runtime_blocker(
                evidence=state.evidence,
                root=state.root,
                data_root=state.data_root,
                instance_id=state.instance_id,
                run_result=state.run_result,
            )
            if not blocked:
                await run_post_wait_checks(state)
                await archive_tree_and_runtime_artifacts(state)
                await run_service_recovery_and_cleanup_checks(state)
    except Exception as exc:
        record_unhandled_e2e_exception(state.evidence, exc)
    finally:
        try:
            await archive_early_exit_artifacts(state)
        except Exception as exc:
            record_e2e_exception(
                state.evidence,
                name="real-e2e:evidence-archive-failed",
                error_code="e2e_evidence_archive_failed",
                next_action="inspect_e2e_evidence",
                retryable=False,
                exc=exc,
            )
        _stop_processes(state)
        _stop_e2e_postgres(state)
        _cleanup_staged_codex_home(state)
        _scrub_runtime_credentials(state)
    return _finish(state)


def _finish_bootstrap_failure(args: argparse.Namespace, exc: Exception) -> dict[str, Any]:
    root = Path(args.out).resolve()
    evidence = Evidence(root / "real-symphony-e2e-report.json")
    record_unhandled_e2e_exception(evidence, exc)
    evidence.data["completed_at"] = utc_now()
    evidence.write()
    return evidence.data


def _stop_processes(state: Any) -> None:
    for process in reversed(state.processes):
        try:
            process.stop()
        except Exception as exc:
            record_e2e_exception(
                state.evidence,
                name="real-e2e:process-cleanup-failed",
                failure_class="environment_failure",
                error_code="e2e_process_cleanup_failed",
                next_action="inspect_process_cleanup",
                retryable=False,
                exc=exc,
            )


def _stop_e2e_postgres(state: Any) -> None:
    try:
        stop_e2e_postgres(state.postgres_container)
    except Exception as exc:
        record_e2e_exception(
            state.evidence,
            name="real-e2e:postgres-cleanup-failed",
            failure_class="environment_failure",
            error_code="e2e_postgres_cleanup_failed",
            next_action="stop_e2e_postgres",
            retryable=False,
            exc=exc,
        )


def _cleanup_staged_codex_home(state: Any) -> None:
    try:
        staged_codex_home = getattr(state, "staged_codex_home", None)
        cleanup_staged_codex_home(staged_codex_home)
        if staged_codex_home is not None:
            state.evidence.check("runtime-config:codex-home-source-cleaned", True)
    except Exception as exc:
        record_e2e_exception(
            state.evidence,
            name="real-e2e:codex-home-cleanup-failed",
            failure_class="environment_failure",
            error_code="e2e_codex_home_cleanup_failed",
            next_action="remove_staged_codex_home",
            retryable=False,
            exc=exc,
        )


def _scrub_runtime_credentials(state: Any) -> None:
    data_root = getattr(state, "data_root", None)
    if data_root is None:
        return
    try:
        removed = scrub_e2e_runtime_credentials(Path(data_root))
        state.evidence.check("runtime-config:e2e-runtime-credentials-cleaned", True, removed_auth_files=removed)
    except Exception as exc:
        record_e2e_exception(
            state.evidence,
            name="real-e2e:runtime-credential-cleanup-failed",
            failure_class="environment_failure",
            error_code="e2e_runtime_credentials_cleanup_failed",
            next_action="remove_e2e_runtime_credentials",
            retryable=False,
            exc=exc,
        )


def _finish(state: Any) -> dict[str, Any]:
    state.evidence.data["completed_at"] = utc_now()
    state.evidence.write()
    return state.evidence.data
