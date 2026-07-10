from __future__ import annotations

import asyncio
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence
from real_symphony_e2e_errors import E2EConfigurationError
from real_symphony_e2e_podium import PodiumSession, _config_error


ENROLLMENT_PATH = "/api/v1/onboarding/runtime/enrollment-token"
BINDING_PATH = "/api/v1/conductors/{conductor_id}/binding"


def build_project_binding_payload(project_id: str, repository: Path) -> dict[str, Any]:
    return {
        "linear_project_id": project_id,
        "repository": {"mode": "local_path", "value": str(repository)},
    }


def validate_enrollment_result(reservation: dict[str, Any], enrolled: dict[str, Any]) -> None:
    conductor = reservation.get("conductor") if isinstance(reservation.get("conductor"), dict) else {}
    valid = bool(
        conductor.get("id")
        and conductor.get("id") == enrolled.get("runtime_id")
        and enrolled.get("runtime_group_id")
        and enrolled.get("runtime_token")
        and enrolled.get("proxy_token")
    )
    if valid:
        return
    raise _config_error(
        "conductor_enrollment_identity_mismatch",
        "The generated install command enrolled a different or incomplete Conductor identity",
        "inspect_conductor_install_log",
    )


def validate_unbound_conductor(conductor: dict[str, Any], conductor_id: str) -> None:
    valid = bool(
        conductor.get("id") == conductor_id
        and conductor.get("online")
        and conductor.get("binding") is None
        and not (conductor.get("bindings") or [])
    )
    if valid:
        return
    raise _config_error(
        "conductor_not_initially_unbound",
        "The enrolled Conductor was not online and unbound before project assignment",
        "inspect_podium_runtime",
    )


async def reserve_conductor(session: PodiumSession, evidence: Evidence) -> dict[str, Any]:
    reservation = await session.request("POST", ENROLLMENT_PATH, {"name": "Bach"})
    conductor = reservation.get("conductor") if isinstance(reservation.get("conductor"), dict) else {}
    ready = bool(reservation.get("enrollment_token") and reservation.get("install_command") and conductor.get("id"))
    evidence.check(
        "conductor-enrollment:reserved",
        ready,
        conductor_id=conductor.get("id"),
        conductor_name=conductor.get("name"),
        public_id=conductor.get("public_id"),
    )
    if not ready:
        raise _config_error("conductor_enrollment_invalid", "Podium returned an incomplete enrollment", "inspect_podium_log")
    return reservation


async def execute_install_command(
    reservation: dict[str, Any],
    *,
    env: dict[str, str],
    conductor_port: int,
    root: Path,
) -> dict[str, Any]:
    result_path = root / ".runtime-enrollment-result.json"
    command_env = dict(env)
    command_env.update(
        {
            "PODIUM_START_CONDUCTOR": "0",
            "PODIUM_CONDUCTOR_PORT": str(conductor_port),
            "PODIUM_ENROLLMENT_RESULT_PATH": str(result_path),
        }
    )
    command = str(reservation.get("install_command") or "")
    token = str(reservation.get("enrollment_token") or "")
    completed = await asyncio.to_thread(
        subprocess.run,
        ["bash", "-c", command],
        env=command_env,
        capture_output=True,
        check=False,
        timeout=90,
    )
    output = (completed.stdout + completed.stderr).decode(errors="replace").replace(token, "<redacted>")
    (root / "conductor-install.log").write_text(output, encoding="utf-8")
    try:
        if completed.returncode != 0 or not result_path.is_file():
            raise _config_error("conductor_install_failed", "Generated Conductor install command failed", "inspect_conductor_install_log")
        return json.loads(result_path.read_text(encoding="utf-8"))
    finally:
        result_path.unlink(missing_ok=True)


async def wait_for_runtime_online(
    session: PodiumSession,
    conductor_id: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        payload = await session.request("GET", "/api/v1/runtimes")
        conductors = payload.get("conductors") if isinstance(payload.get("conductors"), list) else []
        conductor = next((row for row in conductors if isinstance(row, dict) and row.get("id") == conductor_id), None)
        if conductor and conductor.get("online"):
            return conductor
        await asyncio.sleep(0.5)
    raise _config_error("conductor_online_timeout", "Enrolled Conductor did not become online", "inspect_conductor_log")


async def bind_conductor(
    session: PodiumSession,
    *,
    conductor_id: str,
    project_id: str,
    repository: Path,
    evidence: Evidence,
    timeout_seconds: int,
) -> dict[str, Any]:
    path = BINDING_PATH.format(conductor_id=conductor_id)
    await session.request("PUT", path, build_project_binding_payload(project_id, repository))
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        binding = await _current_binding(session, conductor_id)
        if binding.get("state") == "ready":
            ready = bool(binding.get("instance_id") and binding.get("label_id") and binding.get("label_name"))
            evidence.check(
                "conductor-binding:ready",
                ready,
                conductor_id=conductor_id,
                binding_id=binding.get("id"),
                instance_id=binding.get("instance_id"),
                project_id=binding.get("linear_project_id"),
                label_id=binding.get("label_id"),
                label_name=binding.get("label_name"),
            )
            if not ready:
                raise _config_error("project_binding_incomplete", "Ready binding is missing identity or label evidence", "inspect_podium_log")
            return binding
        if binding.get("error_code"):
            raise _config_error(str(binding["error_code"]), str(binding.get("sanitized_reason") or "Project binding failed"), "repair_project_binding")
        await asyncio.sleep(0.5)
    raise _config_error("project_binding_timeout", "Conductor did not acknowledge its project binding", "inspect_conductor_log")


async def verify_second_binding_rejected(
    session: PodiumSession,
    *,
    conductor_id: str,
    project_id: str,
    repository: Path,
    evidence: Evidence,
) -> None:
    path = BINDING_PATH.format(conductor_id=conductor_id)
    probe_project_id = f"{project_id}-second-project-probe"
    try:
        await session.request("PUT", path, build_project_binding_payload(probe_project_id, repository))
    except E2EConfigurationError as exc:
        rejected = exc.error_code == "conductor_already_bound"
        evidence.check(
            "conductor-binding:second-project-rejected",
            rejected,
            conductor_id=conductor_id,
            error_code=exc.error_code,
            sanitized_reason=exc.sanitized_reason,
        )
        if rejected:
            return
        raise
    evidence.check(
        "conductor-binding:second-project-rejected",
        False,
        conductor_id=conductor_id,
        error_code="second_project_binding_accepted",
    )
    raise _config_error(
        "second_project_binding_accepted",
        "A ready Conductor accepted a second project binding",
        "inspect_project_binding_invariant",
    )


async def _current_binding(session: PodiumSession, conductor_id: str) -> dict[str, Any]:
    payload = await session.request("GET", "/api/v1/runtimes")
    conductors = payload.get("conductors") if isinstance(payload.get("conductors"), list) else []
    conductor = next((row for row in conductors if isinstance(row, dict) and row.get("id") == conductor_id), None)
    return conductor.get("binding") if isinstance(conductor, dict) and isinstance(conductor.get("binding"), dict) else {}
