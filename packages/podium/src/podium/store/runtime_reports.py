from __future__ import annotations

import sqlite3

from podium.conductor_bindings import RuntimeReport, RuntimeStatus


class StaleRuntimeReport(ValueError):
    pass


class RuntimeReportRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def save(self, report: RuntimeReport) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            binding = self.connection.execute(
                "SELECT generation, active FROM conductor_bindings WHERE binding_id = ?",
                (report.binding_id,),
            ).fetchone()
            if binding is None or not binding["active"]:
                raise StaleRuntimeReport("runtime_binding_inactive")
            if report.generation != binding["generation"]:
                raise StaleRuntimeReport("runtime_report_stale_generation")
            current = self.connection.execute(
                "SELECT heartbeat_at FROM runtime_reports WHERE binding_id = ?",
                (report.binding_id,),
            ).fetchone()
            if current is not None and report.heartbeat_at < current["heartbeat_at"]:
                raise StaleRuntimeReport("runtime_report_stale_heartbeat")
            self.connection.execute(
                """INSERT INTO runtime_reports (
                    binding_id, generation, instance_id, status, heartbeat_at, error_code
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(binding_id) DO UPDATE SET
                    generation = excluded.generation,
                    instance_id = excluded.instance_id,
                    status = excluded.status,
                    heartbeat_at = excluded.heartbeat_at,
                    error_code = excluded.error_code""",
                (
                    report.binding_id,
                    report.generation,
                    report.instance_id,
                    report.status.value,
                    report.heartbeat_at,
                    report.error_code,
                ),
            )

    def get(self, binding_id: str) -> RuntimeReport | None:
        row = self.connection.execute(
            """SELECT binding_id, generation, instance_id, status, heartbeat_at, error_code
            FROM runtime_reports
            WHERE binding_id = ? AND generation = (
                SELECT generation FROM conductor_bindings
                WHERE binding_id = ? AND active = 1
            )""",
            (binding_id, binding_id),
        ).fetchone()
        if row is None:
            return None
        return RuntimeReport(
            binding_id=row["binding_id"],
            generation=row["generation"],
            instance_id=row["instance_id"],
            status=RuntimeStatus(row["status"]),
            heartbeat_at=row["heartbeat_at"],
            error_code=row["error_code"],
        )
