from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable

from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject

from .records import InstallationRecord, ProjectRecord


class ProjectSelectionConflict(ValueError):
    pass


class LinearRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def save_installation(self, metadata: InstallationMetadata) -> None:
        scopes = json.dumps(metadata.granted_scopes, separators=(",", ":"))
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            existing = self.connection.execute(
                "SELECT organization_id FROM linear_installations WHERE installation_id = ?",
                (metadata.installation_id,),
            ).fetchone()
            if (
                existing is not None
                and existing["organization_id"] != metadata.organization_id
            ):
                raise ValueError("linear_installation_organization_mismatch")
            self.connection.execute(
                """INSERT INTO linear_installations (
                    installation_id, organization_id, organization_name, app_user_id,
                    granted_scopes, expires_at, status, last_verified_at, error_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(installation_id) DO UPDATE SET
                    organization_id = excluded.organization_id,
                    organization_name = excluded.organization_name,
                    app_user_id = excluded.app_user_id,
                    granted_scopes = excluded.granted_scopes,
                    expires_at = excluded.expires_at,
                    status = excluded.status,
                    last_verified_at = excluded.last_verified_at,
                    error_code = excluded.error_code""",
                (
                    metadata.installation_id,
                    metadata.organization_id,
                    metadata.organization_name,
                    metadata.app_user_id,
                    scopes,
                    metadata.expires_at,
                    metadata.status.value,
                    metadata.last_verified_at,
                    metadata.error_code,
                ),
            )

    def installation(self, installation_id: str) -> InstallationRecord | None:
        row = self.connection.execute(
            """SELECT installation_id, organization_id, organization_name, app_user_id,
            granted_scopes, expires_at, status, last_verified_at, error_code
            FROM linear_installations WHERE installation_id = ?""",
            (installation_id,),
        ).fetchone()
        if row is None:
            return None
        return InstallationRecord(
            installation_id=row["installation_id"],
            organization_id=row["organization_id"],
            organization_name=row["organization_name"],
            app_user_id=row["app_user_id"],
            granted_scopes=tuple(json.loads(row["granted_scopes"])),
            expires_at=row["expires_at"],
            status=InstallationStatus(row["status"]),
            last_verified_at=row["last_verified_at"],
            error_code=row["error_code"],
        )

    def replace_projects(
        self, installation_id: str, projects: Iterable[LinearProject]
    ) -> None:
        projects = tuple(projects)
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            installation = self.connection.execute(
                "SELECT organization_id FROM linear_installations WHERE installation_id = ?",
                (installation_id,),
            ).fetchone()
            if installation is None:
                raise ProjectSelectionConflict("linear_installation_not_found")
            if any(
                project.organization_id != installation["organization_id"]
                for project in projects
            ):
                raise ProjectSelectionConflict("linear_project_organization_mismatch")
            existing = {
                row["project_id"]: row["installation_id"]
                for row in self.connection.execute(
                    "SELECT project_id, installation_id FROM linear_projects"
                )
            }
            if any(
                project.project_id in existing
                and existing[project.project_id] != installation_id
                for project in projects
            ):
                raise ProjectSelectionConflict("linear_project_installation_mismatch")
            self.connection.execute(
                "DELETE FROM linear_projects WHERE installation_id = ? AND selected = 0",
                (installation_id,),
            )
            for project in projects:
                self.connection.execute(
                    """INSERT INTO linear_projects (
                        project_id, installation_id, organization_id, team_id, name, slug
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id) DO UPDATE SET
                        team_id = excluded.team_id,
                        name = excluded.name,
                        slug = excluded.slug""",
                    (
                        project.project_id,
                        installation_id,
                        project.organization_id,
                        project.team_id,
                        project.name,
                        project.slug,
                    ),
                )

    def replace_selection(
        self,
        installation_id: str,
        project_ids: Iterable[str],
        *,
        protected_project_ids: Iterable[str],
    ) -> None:
        selected = set(project_ids)
        protected = set(protected_project_ids)
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            current = {
                row[0]
                for row in self.connection.execute(
                    """SELECT project_id FROM linear_projects
                    WHERE installation_id = ? AND selected = 1""",
                    (installation_id,),
                )
            }
            if (current - selected) & protected:
                raise ProjectSelectionConflict("linear_project_bound")
            known = {
                row[0]
                for row in self.connection.execute(
                    "SELECT project_id FROM linear_projects WHERE installation_id = ?",
                    (installation_id,),
                )
            }
            if not selected <= known:
                raise ProjectSelectionConflict("linear_project_not_found")
            self.connection.execute(
                "UPDATE linear_projects SET selected = 0 WHERE installation_id = ?",
                (installation_id,),
            )
            self.connection.executemany(
                "UPDATE linear_projects SET selected = 1 WHERE project_id = ?",
                ((project_id,) for project_id in selected),
            )

    def projects(self, installation_id: str | None = None) -> list[ProjectRecord]:
        where = "" if installation_id is None else "WHERE installation_id = ?"
        parameters = () if installation_id is None else (installation_id,)
        rows = self.connection.execute(
            f"""SELECT project_id, installation_id, organization_id, team_id, name, slug,
            selected FROM linear_projects {where} ORDER BY project_id""",
            parameters,
        ).fetchall()
        return [
            ProjectRecord(
                project_id=row["project_id"],
                installation_id=row["installation_id"],
                organization_id=row["organization_id"],
                team_id=row["team_id"],
                name=row["name"],
                slug=row["slug"],
                selected=bool(row["selected"]),
            )
            for row in rows
        ]
