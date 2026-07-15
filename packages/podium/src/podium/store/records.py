from __future__ import annotations

from dataclasses import dataclass

from podium.linear_models import InstallationStatus


@dataclass(frozen=True)
class InstallationRecord:
    installation_id: str
    organization_id: str
    organization_name: str
    app_user_id: str
    granted_scopes: tuple[str, ...]
    expires_at: int | None
    status: InstallationStatus
    last_verified_at: int | None
    error_code: str | None


@dataclass(frozen=True)
class ProjectRecord:
    project_id: str
    installation_id: str
    organization_id: str
    team_id: str
    name: str
    slug: str
    bound: bool
