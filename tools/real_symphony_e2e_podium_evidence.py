from __future__ import annotations

import json
import asyncio
import time
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence, redact_evidence_value
from real_symphony_e2e_errors import E2EConfigurationError


PODIUM_SNAPSHOT_ENDPOINTS = {
    "managed_runs": "/api/v1/managed-runs",
    "linear_installations": "/api/v1/linear/installations",
    "linear_projects": "/api/v1/linear/projects",
    "runtimes": "/api/v1/runtimes",
}


async def archive_podium_api_snapshots(
    session: Any,
    *,
    root: Path,
    evidence: Evidence,
    prefix: str,
) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}
    for name, endpoint in PODIUM_SNAPSHOT_ENDPOINTS.items():
        payload = await session.request("GET", endpoint)
        sanitized = redact_evidence_value(payload)
        snapshots[name] = sanitized
        path = root / f"{prefix}-podium-{name.replace('_', '-')}.json"
        path.write_text(json.dumps(sanitized, indent=2, sort_keys=True), encoding="utf-8")
        evidence.artifact(f"{prefix}_podium_{name}", path)
    return snapshots


async def archive_and_validate_podium_bootstrap(
    session: Any,
    *,
    root: Path,
    evidence: Evidence,
    installation_id: str,
    project_id: str,
    conductor_id: str,
) -> None:
    snapshots = await archive_podium_api_snapshots(
        session,
        root=root,
        evidence=evidence,
        prefix="bootstrap",
    )
    summary = validate_podium_bootstrap_snapshots(
        snapshots,
        installation_id=installation_id,
        project_id=project_id,
        conductor_id=conductor_id,
    )
    evidence.check("podium-api:bootstrap-authority-agrees", True, **summary)


def validate_podium_bootstrap_snapshots(
    snapshots: dict[str, dict[str, Any]],
    *,
    installation_id: str,
    project_id: str,
    conductor_id: str,
) -> dict[str, Any]:
    active = snapshots.get("linear_installations", {}).get("active") or {}
    projects = snapshots.get("linear_projects", {}).get("projects") or []
    selected_ids = [str(row.get("id") or "") for row in projects if isinstance(row, dict) and row.get("selected")]
    runtimes = snapshots.get("runtimes", {}).get("conductors") or []
    conductor = next(
        (row for row in runtimes if isinstance(row, dict) and row.get("id") == conductor_id),
        {},
    )
    binding = conductor.get("binding") if isinstance(conductor.get("binding"), dict) else {}
    reports = snapshots.get("managed_runs", {}).get("conductors") or []
    report = next(
        (row for row in reports if isinstance(row, dict) and (row.get("conductor") or {}).get("id") == conductor_id),
        {},
    )
    valid = bool(
        active.get("id") == installation_id
        and active.get("state") == "ready"
        and selected_ids == [project_id]
        and conductor.get("online")
        and binding.get("state") == "ready"
        and binding.get("linear_project_id") == project_id
        and (report.get("project") or {}).get("id") == project_id
        and (report.get("binding") or {}).get("state") == "ready"
    )
    if not valid:
        raise _evidence_error(
            "podium_bootstrap_evidence_incomplete",
            "Podium installation, project, Conductor, and Managed Runs views do not agree",
            "inspect_podium_bootstrap_snapshots",
        )
    return {
        "installation_id": installation_id,
        "project_id": project_id,
        "conductor_id": conductor_id,
        "binding_id": binding.get("id"),
        "instance_id": binding.get("instance_id"),
    }


def validate_podium_final_managed_run(
    snapshots: dict[str, dict[str, Any]],
    *,
    issue_id: str,
    issue_identifier: str,
) -> dict[str, Any]:
    reports = snapshots.get("managed_runs", {}).get("conductors") or []
    runs = [
        run
        for report in reports
        if isinstance(report, dict)
        for run in (report.get("managed_runs") or {}).get("runs") or []
        if isinstance(run, dict)
    ]
    run = next(
        (
            row
            for row in runs
            if row.get("parent_issue_id") == issue_id or row.get("issue_identifier") == issue_identifier
        ),
        None,
    )
    if run is None:
        raise _evidence_error(
            "podium_managed_run_evidence_missing",
            "Podium Managed Runs does not contain the real Linear issue",
            "wait_for_podium_managed_run_report",
        )
    return run


async def wait_for_podium_managed_run(
    session: Any,
    *,
    issue_id: str,
    issue_identifier: str,
    timeout_seconds: int,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        payload = await session.request("GET", PODIUM_SNAPSHOT_ENDPOINTS["managed_runs"])
        try:
            validate_podium_final_managed_run(
                {"managed_runs": payload},
                issue_id=issue_id,
                issue_identifier=issue_identifier,
            )
            return
        except E2EConfigurationError:
            await asyncio.sleep(0.5)
    raise _evidence_error(
        "podium_managed_run_evidence_timeout",
        "Podium did not report the real Managed Run before the evidence deadline",
        "inspect_runtime_reporting",
    )


def _evidence_error(code: str, reason: str, next_action: str) -> E2EConfigurationError:
    return E2EConfigurationError(
        failure_class="product_failure",
        error_code=code,
        sanitized_reason=reason,
        retryable=False,
        next_action=next_action,
    )
