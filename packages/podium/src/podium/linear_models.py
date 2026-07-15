from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import re


class InstallationStatus(StrEnum):
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    CREDENTIALS_MISSING = "credentials_missing_for_existing_installation"
    REAUTHORIZATION_REQUIRED = "reauthorization_required"


@dataclass(frozen=True)
class InstallationMetadata:
    installation_id: str
    organization_id: str
    organization_name: str
    app_user_id: str
    granted_scopes: tuple[str, ...]
    expires_at: int | None
    status: InstallationStatus
    last_verified_at: int | None
    error_code: str | None

    def __post_init__(self) -> None:
        if self.error_code is not None and re.fullmatch(
            r"[a-z][a-z0-9_]*", self.error_code
        ) is None:
            raise ValueError("linear_error_code_invalid")


@dataclass(frozen=True)
class LinearProject:
    project_id: str
    organization_id: str
    team_id: str
    name: str
    slug: str
