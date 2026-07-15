from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass, field

from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject

from .records import InstallationRecord, ProjectRecord


class ProjectSelectionConflict(ValueError):
    pass


@dataclass(frozen=True)
class LinearCredentials:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: int


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

    def load_credentials(self, installation_id: str) -> LinearCredentials | None:
        row = self.connection.execute(
            """SELECT access_token, refresh_token, expires_at
            FROM linear_installations
            WHERE installation_id = ? AND status = 'connected'""",
            (installation_id,),
        ).fetchone()
        if row is None:
            return None
        return LinearCredentials(
            access_token=row["access_token"],
            refresh_token=row["refresh_token"],
            expires_at=row["expires_at"],
        )

    def replace_credentials(
        self,
        installation_id: str,
        access_token: str,
        refresh_token: str,
        *,
        expires_at: int,
    ) -> None:
        _validate_credentials(access_token, refresh_token, expires_at)
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            cursor = self.connection.execute(
                """UPDATE linear_installations
                SET access_token = ?, refresh_token = ?, expires_at = ?,
                    status = 'connected', error_code = NULL
                WHERE installation_id = ?""",
                (access_token, refresh_token, expires_at, installation_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")

    def clear_credentials(self, installation_id: str) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            cursor = self.connection.execute(
                """UPDATE linear_installations
                SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    status = 'disconnected'
                WHERE installation_id = ?""",
                (installation_id,),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")

    def mark_credentials_missing(self, installation_id: str) -> None:
        self._clear_with_status(
            installation_id,
            InstallationStatus.CREDENTIALS_MISSING,
            "credentials_missing_for_existing_installation",
        )

    def reset_after_removal(self, installation_id: str) -> None:
        self._clear_with_status(
            installation_id, InstallationStatus.DISCONNECTED, None
        )

    def disconnect(self, installation_id: str) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            self.ensure_disconnect_allowed(installation_id)
            cursor = self.connection.execute(
                """UPDATE linear_installations
                SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    status = 'disconnected', error_code = NULL
                WHERE installation_id = ?""",
                (installation_id,),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")
            self.connection.execute(
                "UPDATE linear_projects SET selected = 0 WHERE installation_id = ?",
                (installation_id,),
            )

    def ensure_disconnect_allowed(self, installation_id: str) -> None:
        blocked = self.connection.execute(
            """SELECT 1 FROM conductor_bindings AS binding
            JOIN linear_projects AS project ON project.project_id = binding.project_id
            WHERE project.installation_id = ? AND binding.active = 1 LIMIT 1""",
            (installation_id,),
        ).fetchone()
        if blocked is not None:
            raise ValueError("linear_disconnect_in_use")

    def reject_credentials(self, installation_id: str, error_code: str) -> None:
        if re.fullmatch(r"[a-z][a-z0-9_]*", error_code) is None:
            raise ValueError("linear_error_code_invalid")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            cursor = self.connection.execute(
                """UPDATE linear_installations
                SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    status = 'reauthorization_required', error_code = ?
                WHERE installation_id = ?""",
                (error_code, installation_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")

    def record_error(self, installation_id: str, error_code: str) -> None:
        if re.fullmatch(r"[a-z][a-z0-9_]*", error_code) is None:
            raise ValueError("linear_error_code_invalid")
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE linear_installations SET error_code = ? WHERE installation_id = ?",
                (error_code, installation_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")

    def record_error_if_clear_or_owned(
        self,
        installation_id: str,
        error_code: str,
        *,
        owned_codes: Iterable[str],
    ) -> None:
        if re.fullmatch(r"[a-z][a-z0-9_]*", error_code) is None:
            raise ValueError("linear_error_code_invalid")
        owned_codes = tuple(owned_codes)
        placeholders = ",".join("?" for _ in owned_codes)
        with self.connection:
            self.connection.execute(
                f"""UPDATE linear_installations SET error_code = ?
                WHERE installation_id = ?
                AND (error_code IS NULL OR error_code IN ({placeholders}))""",
                (error_code, installation_id, *owned_codes),
            )

    def _clear_with_status(
        self,
        installation_id: str,
        status: InstallationStatus,
        error_code: str | None,
    ) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            cursor = self.connection.execute(
                """UPDATE linear_installations
                SET access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    status = ?, error_code = ?
                WHERE installation_id = ?""",
                (status.value, error_code, installation_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("linear_installation_not_found")

    def replace_projects(
        self,
        installation_id: str,
        projects: Iterable[LinearProject],
        *,
        clear_error_codes: Iterable[str] = (),
    ) -> None:
        projects = tuple(projects)
        clear_error_codes = tuple(clear_error_codes)
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
            if clear_error_codes:
                placeholders = ",".join("?" for _ in clear_error_codes)
                self.connection.execute(
                    f"""UPDATE linear_installations SET error_code = NULL
                    WHERE installation_id = ? AND error_code IN ({placeholders})""",
                    (installation_id, *clear_error_codes),
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


def _validate_credentials(
    access_token: str, refresh_token: str, expires_at: int
) -> None:
    if not isinstance(access_token, str) or not access_token:
        raise ValueError("linear_credential_pair_invalid")
    if not isinstance(refresh_token, str) or not refresh_token:
        raise ValueError("linear_credential_pair_invalid")
    if isinstance(expires_at, bool) or not isinstance(expires_at, int) or expires_at < 1:
        raise ValueError("linear_credential_pair_invalid")
