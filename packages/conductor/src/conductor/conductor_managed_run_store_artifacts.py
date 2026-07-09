from __future__ import annotations

from typing import Any

from performer_api.managed_runs import GateSnapshot, ManagedRunPlan, TaskOutputManifest, VerificationInputSnapshot


def gate_snapshots_for_plan(
    *,
    run_id: str,
    plan: ManagedRunPlan,
    plan_version: int,
    creator_attempt_id: str,
    created_at: str,
) -> list[dict[str, Any]]:
    return [
        GateSnapshot.from_work_item(
            run_id=run_id,
            work_item=item,
            plan_version=plan_version,
            creator_attempt_id=creator_attempt_id,
            created_at=created_at,
        ).to_dict()
        for item in plan.work_items
    ]


class ConductorManagedRunStoreArtifactsMixin:
    def list_gate_snapshots(self, run_id: str) -> list[dict[str, Any]]:
        payload = self._payload_for_run(run_id)
        return [dict(item) for item in payload.get("gate_snapshots") or [] if isinstance(item, dict)]

    def get_gate_snapshot(self, content_hash: str) -> dict[str, Any] | None:
        for run in self.list_runs():
            for snapshot in self.list_gate_snapshots(str(run["run_id"])):
                if snapshot.get("content_hash") == content_hash:
                    return snapshot
        return None

    def record_verification_input(self, run_id: str, snapshot: VerificationInputSnapshot) -> dict[str, Any]:
        payload = self._payload_for_run(run_id)
        snapshots = [
            dict(item)
            for item in payload.get("verification_inputs") or []
            if isinstance(item, dict) and item.get("execute_attempt_id") != snapshot.execute_attempt_id
        ]
        snapshots.append(snapshot.to_dict())
        self.merge_run_payload(run_id, {"verification_inputs": snapshots})
        return snapshot.to_dict()

    def list_verification_inputs(self, run_id: str) -> list[dict[str, Any]]:
        payload = self._payload_for_run(run_id)
        return [dict(item) for item in payload.get("verification_inputs") or [] if isinstance(item, dict)]

    def publish_task_output_manifest(self, run_id: str, manifest: TaskOutputManifest) -> dict[str, Any]:
        errors = manifest.validation_errors()
        if errors:
            raise ValueError("invalid task output manifest: " + ",".join(errors))
        payload = self._payload_for_run(run_id)
        manifests = [
            dict(item)
            for item in payload.get("manifests") or []
            if isinstance(item, dict) and item.get("verify_attempt_id") != manifest.verify_attempt_id
        ]
        manifests.append(manifest.to_dict())
        self.merge_run_payload(run_id, {"manifests": manifests})
        return manifest.to_dict()

    def list_task_output_manifests(self, run_id: str) -> list[dict[str, Any]]:
        payload = self._payload_for_run(run_id)
        return [dict(item) for item in payload.get("manifests") or [] if isinstance(item, dict)]

    def _payload_for_run(self, run_id: str) -> dict[str, Any]:
        run = self.get_run(run_id) or {}
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        return dict(payload)


__all__ = ["ConductorManagedRunStoreArtifactsMixin", "gate_snapshots_for_plan"]
