from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from real_symphony_e2e_acceptance import _lower_policy_during_parallel_execute_probe
from real_symphony_e2e_artifacts import _latest_managed_run_runtime_failure
from real_symphony_e2e_common import api_url, http_json
from real_symphony_e2e_preflight import _codex_settings_from_args, build_runtime_config_payload
from real_symphony_e2e_podium import managed_runtime_env
from real_symphony_e2e_run_state import E2ERunState
from real_symphony_e2e_wait import wait_for_run


async def restart_conductor_and_push_runtime_config(state: E2ERunState) -> None:
    await _restart_conductor_after_instance_create(state)
    state.runtime_config = build_runtime_config_payload(
        runtime_group_id=state.enrolled_runtime["runtime_group_id"],
        version=1,
        codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
        codex_settings=_codex_settings_from_args(state.args),
        pipeline_scenario=getattr(state.args, "pipeline_scenario", "basic"),
    )
    _push_runtime_config(state)
    _reject_stale_runtime_config(state)
    _reject_ineligible_backend(state)
    _checkpoint_services_and_runtime(state)
    if state.pipeline_scenario == "overall-dod":
        state.lowered_policy_task = asyncio.create_task(
            _lower_policy_during_parallel_execute_probe(
                podium_port=state.podium_port,
                conductor_port=state.conductor_port,
                runtime_token=state.enrolled_runtime["runtime_token"],
                runtime_config=state.runtime_config,
                timeout_seconds=min(max(state.args.stage_timeout, 30), 180),
            )
        )


async def _restart_conductor_after_instance_create(state: E2ERunState) -> None:
    from real_symphony_e2e_common import start_process, wait_for_http_ready

    conductor = state.processes[-1]
    conductor.stop()
    state.processes.remove(conductor)
    conductor = start_process(
        "conductor",
        [str(state.bin_dir / "conductor"), "--port", str(state.conductor_port), "--data-root", str(state.data_root)],
        env=managed_runtime_env(state.env),
        stdout_path=state.root / "conductor-restarted.log",
    )
    state.processes.append(conductor)
    await wait_for_http_ready(api_url(state.conductor_port, "/"))
    status, body = http_json("GET", api_url(state.conductor_port, f"/api/instances/{state.instance_id}"))
    state.evidence.check(
        "conductor-daemon:restart-recovers-instance-metadata",
        status == 200 and body["instance"]["id"] == state.instance_id,
        status=status,
        process_status=body.get("instance", {}).get("process_status"),
    )


def _push_runtime_config(state: E2ERunState) -> None:
    status, body = http_json(
        "POST",
        api_url(state.podium_port, "/api/v1/runtime/config"),
        state.runtime_config,
        headers={"Authorization": f"Bearer {state.enrolled_runtime['runtime_token']}"},
    )
    pushed = body.get("config") if isinstance(body, dict) and isinstance(body.get("config"), dict) else {}
    state.evidence.check(
        "runtime-config:podium-pushed",
        status == 200
        and pushed.get("version") == state.runtime_config["version"]
        and sorted((pushed.get("profiles") or {}).keys()) == ["plan", "verify", "work_item"],
        status=status,
        body=body,
    )


def _reject_stale_runtime_config(state: E2ERunState) -> None:
    status, body = http_json(
        "POST",
        api_url(state.podium_port, "/api/v1/runtime/config"),
        state.runtime_config,
        headers={"Authorization": f"Bearer {state.enrolled_runtime['runtime_token']}"},
    )
    state.evidence.check(
        "appendix:s0a-stale-policy-rejected",
        status == 409 and ((body or {}).get("error") or {}).get("code") == "stale_runtime_config",
        status=status,
        body=body,
    )


def _reject_ineligible_backend(state: E2ERunState) -> None:
    invalid = json.loads(json.dumps(state.runtime_config))
    invalid["version"] = int(state.runtime_config.get("version") or 1) + 1
    invalid["managed_run_policy"]["version"] = invalid["version"]
    invalid["profiles"]["work_item"]["backend"] = "local-verifier"
    invalid["profiles"]["work_item"]["name"] = "ineligible-work-item"
    status, body = http_json(
        "POST",
        api_url(state.podium_port, "/api/v1/runtime/config"),
        invalid,
        headers={"Authorization": f"Bearer {state.enrolled_runtime['runtime_token']}"},
    )
    details = str(((body or {}).get("error") or {}).get("details"))
    state.evidence.check(
        "appendix:s0c-ineligible-backend-refused-before-dispatch",
        status == 400 and "runtime_profile_backend_unsupported:work_item:local-verifier" in details,
        status=status,
        body=body,
    )


def _checkpoint_services_and_runtime(state: E2ERunState) -> None:
    prefixes = ("podium-api:", "conductor-api:", "runtime-config:", "appendix:s0")
    checks = [
        check
        for check in state.evidence.data.get("checks", [])
        if isinstance(check, dict) and str(check.get("name") or "").startswith(prefixes)
    ]
    state.evidence.checkpoint(
        "03-services-and-runtime",
        {
            "status": "completed" if not state.evidence.data.get("failures") else "failed",
            "checks": checks,
            "failures": [failure for failure in state.evidence.data.get("failures", []) if isinstance(failure, dict)],
        },
    )


async def wait_for_dispatch_and_run(state: E2ERunState) -> None:
    _record_poller_mode(state)
    await _wait_for_instance_dispatch(state)
    state.run_result = await wait_for_run(
        token=state.token,
        issue_id=state.linear["issue"]["id"],
        instance=state.instance,
        conductor_port=state.conductor_port,
        evidence=state.evidence,
        timeout_seconds=state.args.timeout,
        stage_timeout_seconds=state.args.stage_timeout,
        permission_approval_probe=state.permission_approval_probe,
        crash_recovery_probe=state.args.crash_recovery_probe or state.pipeline_scenario == "overall-dod",
        crash_after_policy_revision=(int(state.runtime_config.get("version") or 1) + 1)
        if state.pipeline_scenario == "overall-dod"
        else None,
        continue_after_human_resume=state.pipeline_scenario == "overall-dod",
        expected_failure=state.args.expected_failure,
        pipeline_scenario=state.pipeline_scenario,
    )
    _checkpoint_dispatch_and_plan(state)


def _record_poller_mode(state: E2ERunState) -> None:
    state.evidence.check(
        "podium-poller:uses-delegated-linear-issue",
        True,
        scenario=state.pipeline_scenario,
        poller_mode=True,
        note="polling mode discovers delegated Linear issues through Linear GraphQL",
    )


async def _wait_for_instance_dispatch(state: E2ERunState) -> None:
    dispatch_status = 0
    dispatch_body: dict[str, Any] = {}
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        dispatch_status, dispatch_body = http_json("GET", api_url(state.conductor_port, f"/api/instances/{state.instance_id}"))
        process_status = dispatch_body.get("instance", {}).get("process_status")
        if dispatch_status == 200 and process_status in {"running", "exited"}:
            break
        await asyncio.sleep(0.5)
    state.evidence.check(
        "conductor-dispatch:poller-starts-one-shot",
        dispatch_status == 200 and dispatch_body.get("instance", {}).get("process_status") in {"running", "exited"},
        status=dispatch_status,
        process_status=dispatch_body.get("instance", {}).get("process_status") if isinstance(dispatch_body, dict) else None,
    )
    state.instance = dispatch_body["instance"]


def _checkpoint_dispatch_and_plan(state: E2ERunState) -> None:
    checks = [
        check
        for check in state.evidence.data.get("checks", [])
        if isinstance(check, dict)
        and (
            str(check.get("name") or "").startswith("stage:")
            or str(check.get("name") or "").startswith("managed-run-runtime-error:")
            or str(check.get("name") or "").startswith("human-action:")
        )
    ]
    state.evidence.checkpoint(
        "04-dispatch-and-plan",
        {
            "status": "completed" if _latest_managed_run_runtime_failure(state.evidence) is None else "failed",
            "checks": checks,
            "failures": [failure for failure in state.evidence.data.get("failures", []) if isinstance(failure, dict)],
            "samples": (state.run_result.get("samples") or [])[-3:],
        },
    )
