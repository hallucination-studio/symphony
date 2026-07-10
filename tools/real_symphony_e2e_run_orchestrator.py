from __future__ import annotations

import argparse
from typing import Any

from real_symphony_e2e_artifacts import _handle_managed_run_runtime_blocker
from real_symphony_e2e_common import utc_now
from real_symphony_e2e_preflight import stop_e2e_postgres
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
    state = await build_initial_state(args)
    if not await run_connectivity_preflight(state):
        return state.evidence.data
    prepare_fixture_and_cli(state)
    try:
        await start_podium_and_enroll(state)
        await start_conductor_and_configure(state)
        await create_issue_and_instance(state)
        await restart_conductor_and_push_runtime_config(state)
        await wait_for_dispatch_and_run(state)
        if _handle_managed_run_runtime_blocker(
            evidence=state.evidence,
            root=state.root,
            data_root=state.data_root,
            instance_id=state.instance_id,
            run_result=state.run_result,
        ):
            return _finish(state)
        await run_post_wait_checks(state)
        await archive_tree_and_runtime_artifacts(state)
        await run_service_recovery_and_cleanup_checks(state)
    finally:
        for process in reversed(state.processes):
            process.stop()
        stop_e2e_postgres(state.postgres_container)
    return _finish(state)


def _finish(state: Any) -> dict[str, Any]:
    state.evidence.data["completed_at"] = utc_now()
    state.evidence.write()
    return state.evidence.data
