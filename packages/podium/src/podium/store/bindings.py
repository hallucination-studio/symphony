from __future__ import annotations

import sqlite3

from podium.conductor_bindings import DesiredBinding


class BindingConflict(ValueError):
    pass


class BindingRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def save(self, binding: DesiredBinding) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            existing = self.connection.execute(
                """SELECT project_id, conductor_id, generation
                FROM conductor_bindings WHERE binding_id = ?""",
                (binding.binding_id,),
            ).fetchone()
            if existing is not None and (
                existing["project_id"] != binding.project_id
                or existing["conductor_id"] != binding.conductor_id
            ):
                raise BindingConflict("binding_identity_mismatch")
            if existing is not None and binding.generation <= existing["generation"]:
                raise BindingConflict("binding_generation_not_increased")
            project = self.connection.execute(
                "SELECT 1 FROM linear_projects WHERE project_id = ?",
                (binding.project_id,),
            ).fetchone()
            if project is None:
                raise BindingConflict("binding_project_not_found")
            if binding.active:
                conflict = self.connection.execute(
                    """SELECT project_id, conductor_id FROM conductor_bindings
                    WHERE active = 1 AND binding_id != ?
                    AND (project_id = ? OR conductor_id = ?)""",
                    (binding.binding_id, binding.project_id, binding.conductor_id),
                ).fetchone()
                if conflict is not None:
                    code = (
                        "active_project_binding_conflict"
                        if conflict["project_id"] == binding.project_id
                        else "active_conductor_binding_conflict"
                    )
                    raise BindingConflict(code)
            self.connection.execute(
                """INSERT INTO conductor_bindings (
                    binding_id, project_id, conductor_id, generation, active
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(binding_id) DO UPDATE SET
                    project_id = excluded.project_id,
                    conductor_id = excluded.conductor_id,
                    generation = excluded.generation,
                    active = excluded.active""",
                (
                    binding.binding_id,
                    binding.project_id,
                    binding.conductor_id,
                    binding.generation,
                    int(binding.active),
                ),
            )

    def create(self, binding: DesiredBinding) -> None:
        if (
            binding.generation != 1
            or not binding.active
            or not binding.repository_path
            or not binding.data_root_key
        ):
            raise BindingConflict("binding_create_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            project = self.connection.execute(
                """SELECT project.project_id
                FROM linear_projects AS project
                JOIN linear_installations AS installation
                  ON installation.installation_id = project.installation_id
                WHERE project.project_id = ? AND installation.status = 'connected'""",
                (binding.project_id,),
            ).fetchone()
            if project is None:
                raise BindingConflict("binding_project_unavailable")
            conflict = self.connection.execute(
                """SELECT project_id, conductor_id, repository_path
                FROM conductor_bindings
                WHERE active = 1 AND (
                    project_id = ? OR conductor_id = ? OR repository_path = ?
                ) LIMIT 1""",
                (
                    binding.project_id,
                    binding.conductor_id,
                    binding.repository_path,
                ),
            ).fetchone()
            if conflict is not None:
                if conflict["project_id"] == binding.project_id:
                    code = "active_project_binding_conflict"
                elif conflict["conductor_id"] == binding.conductor_id:
                    code = "active_conductor_binding_conflict"
                else:
                    code = "active_repository_binding_conflict"
                raise BindingConflict(code)
            self.connection.execute(
                """INSERT INTO conductor_bindings (
                    binding_id, project_id, conductor_id, generation, active,
                    repository_path, data_root_key, desired_state, observed_state
                ) VALUES (?, ?, ?, 1, 1, ?, ?, 'running', 'pending')""",
                (
                    binding.binding_id,
                    binding.project_id,
                    binding.conductor_id,
                    binding.repository_path,
                    binding.data_root_key,
                ),
            )

    def get(self, binding_id: str) -> DesiredBinding | None:
        row = self.connection.execute(
            """SELECT binding_id, project_id, conductor_id, generation, active,
            repository_path, data_root_key, desired_state, observed_state
            FROM conductor_bindings WHERE binding_id = ?""",
            (binding_id,),
        ).fetchone()
        return _binding(row) if row is not None else None

    def get_active(self, binding_id: str) -> DesiredBinding | None:
        binding = self.get(binding_id)
        return binding if binding is not None and binding.active else None

    def active(self) -> list[DesiredBinding]:
        rows = self.connection.execute(
            """SELECT binding_id, project_id, conductor_id, generation, active,
            repository_path, data_root_key, desired_state, observed_state
            FROM conductor_bindings WHERE active = 1 ORDER BY binding_id"""
        ).fetchall()
        return [_binding(row) for row in rows]


def _binding(row: sqlite3.Row) -> DesiredBinding:
    return DesiredBinding(
        binding_id=row["binding_id"],
        project_id=row["project_id"],
        conductor_id=row["conductor_id"],
        generation=row["generation"],
        active=bool(row["active"]),
        repository_path=row["repository_path"],
        data_root_key=row["data_root_key"],
        desired_state=row["desired_state"],
        observed_state=row["observed_state"],
    )
