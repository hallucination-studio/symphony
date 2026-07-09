from __future__ import annotations

from .conductor_pipeline_store_common import *


class IntegrationQueueMixin:
    def publish_task_output_manifest(self, manifest: TaskOutputManifest) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO task_output_manifests (verify_attempt_id, node_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (manifest.verify_attempt_id, manifest.node_id, _json_dumps(manifest.to_dict())),
            )

    def enqueue_integration(self, manifest: TaskOutputManifest) -> dict[str, Any]:
        integration_id = f"integration-{manifest.node_id}-{manifest.verify_attempt_id}"
        payload = {
            "integration_id": integration_id,
            "node_id": manifest.node_id,
            "verify_attempt_id": manifest.verify_attempt_id,
            "gate_snapshot_hash": manifest.gate_snapshot_hash,
            "status": "queued",
            "integrated_revision": None,
            "created_at": _now(),
            "completed_at": None,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO integration_queue
                  (integration_id, node_id, verify_attempt_id, status, payload_json, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    integration_id,
                    manifest.node_id,
                    manifest.verify_attempt_id,
                    "queued",
                    _json_dumps(payload),
                    payload["created_at"],
                    None,
                ),
            )
        return payload

    def list_integration_queue(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM integration_queue ORDER BY created_at, integration_id",
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def current_integrated_revision(self, repository_path: Path | str) -> str | None:
        graph_id = self._current_graph_id()
        if not graph_id:
            return None
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT integrated_revision FROM repository_integrations
                WHERE graph_id = ? AND repository_path = ?
                """,
                (graph_id, _repository_integration_path(repository_path)),
            ).fetchone()
        if row is None:
            return None
        revision = str(row["integrated_revision"] or "").strip()
        return revision or None

    def _record_integrated_revision(self, repository_path: Path | str, integrated_revision: str) -> None:
        graph_id = self._current_graph_id()
        if not graph_id:
            return
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO repository_integrations (graph_id, repository_path, integrated_revision, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(graph_id, repository_path) DO UPDATE SET
                  integrated_revision = excluded.integrated_revision,
                  updated_at = excluded.updated_at
                """,
                (graph_id, _repository_integration_path(repository_path), integrated_revision, _now()),
            )

    def _current_graph_id(self) -> str:
        revision = self.current_graph_revision_record()
        return revision.graph_id if revision is not None else ""

    def process_queued_integrations(self, repository_path: Path, *, instance: Any | None = None) -> int:
        processed = 0
        for item in self.list_integration_queue():
            if item.get("status") != "queued":
                continue
            try:
                integrated_revision = self._integrate_manifest_patch(repository_path, str(item["verify_attempt_id"]))
            except Exception as exc:
                error = _sanitize_error(exc)
                completed = self.complete_integration(str(item["integration_id"]), status="conflict", error=error)
                _append_pipeline_log_event(
                    instance,
                    "pipeline_integration_conflicted",
                    graph_revision=self.current_graph_revision(),
                    policy_revision=self.active_runtime_config().scheduler_policy.version,
                    node_id=str(completed.get("node_id") or ""),
                    attempt_id=str(completed.get("verify_attempt_id") or ""),
                    mode=RuntimeMode.VERIFY.value,
                    lease_id="",
                    integration_id=str(completed.get("integration_id") or ""),
                    error_type=exc.__class__.__name__,
                    sanitized_reason=error,
                    action_required=HumanEscalationReason.LINEAR_SYNC_CONFLICT.value,
                )
                processed += 1
                continue
            completed = self.complete_integration(
                str(item["integration_id"]),
                status="integrated",
                integrated_revision=integrated_revision,
            )
            _append_pipeline_log_event(
                instance,
                "pipeline_integration_completed",
                graph_revision=self.current_graph_revision(),
                policy_revision=self.active_runtime_config().scheduler_policy.version,
                node_id=str(completed.get("node_id") or ""),
                attempt_id=str(completed.get("verify_attempt_id") or ""),
                mode=RuntimeMode.VERIFY.value,
                lease_id="",
                integration_id=str(completed.get("integration_id") or ""),
                integrated_revision=integrated_revision,
            )
            processed += 1
        return processed
