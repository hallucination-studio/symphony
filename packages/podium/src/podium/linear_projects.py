from __future__ import annotations

import logging
import sqlite3
from typing import NoReturn

from .linear_constants import LINEAR_REQUIRED_SCOPES
from .linear_gateway import (
    LinearGateway,
    LinearGatewayFailure,
    validate_linear_correlation_id,
    validate_linear_envelope_id,
)
from .linear_models import InstallationStatus, LinearProject
from .linear_queries import PROJECTS_PAGE
from .store.linear import LinearRepository, ProjectSelectionConflict

LOGGER = logging.getLogger(__name__)
PAGE_SIZE = 50
DISCOVERY_ERROR_CODES = frozenset(
    {
        "linear_project_discovery_authorization_failed",
        "linear_project_discovery_identity_drift",
        "linear_project_discovery_pagination_invalid",
        "linear_project_discovery_persistence_failed",
        "linear_project_discovery_upstream_failed",
    }
)


class LinearProjectDiscoveryFailure(RuntimeError):
    def __init__(self, code: str, *, retryable: bool) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class LinearProjectDiscovery:
    def __init__(self, repository: LinearRepository, gateway: LinearGateway) -> None:
        self.repository = repository
        self.gateway = gateway

    async def discover(self, installation_id: str, *, correlation_id: str) -> int:
        try:
            correlation_id = validate_linear_correlation_id(correlation_id)
        except ValueError:
            self._log_failure(
                "linear_project_discovery_envelope_invalid", False, "invalid"
            )
            raise LinearProjectDiscoveryFailure(
                "linear_project_discovery_envelope_invalid", retryable=False
            ) from None
        try:
            installation_id = validate_linear_envelope_id(installation_id)
        except ValueError:
            self._log_failure(
                "linear_project_discovery_envelope_invalid",
                False,
                correlation_id,
            )
            raise LinearProjectDiscoveryFailure(
                "linear_project_discovery_envelope_invalid", retryable=False
            ) from None
        try:
            installation = self.repository.installation(installation_id)
        except sqlite3.Error:
            self._log_failure(
                "linear_project_discovery_persistence_failed",
                True,
                correlation_id,
                installation_id,
            )
            raise LinearProjectDiscoveryFailure(
                "linear_project_discovery_persistence_failed", retryable=True
            ) from None
        if installation is None:
            self._fail(
                installation_id,
                "linear_installation_not_found",
                False,
                correlation_id,
                record=False,
            )
        if installation.status is not InstallationStatus.CONNECTED:
            self._fail(
                installation_id,
                installation.error_code or "linear_project_installation_not_ready",
                False,
                correlation_id,
                record=False,
            )
        if set(installation.granted_scopes) != LINEAR_REQUIRED_SCOPES:
            self._fail(
                installation_id,
                "linear_project_discovery_identity_drift",
                False,
                correlation_id,
            )

        projects: dict[str, LinearProject] = {}
        after: str | None = None
        seen_cursors: set[str] = set()
        try:
            while True:
                page = await self.gateway.execute(
                    installation_id,
                    PROJECTS_PAGE,
                    {"first": PAGE_SIZE, "after": after},
                    correlation_id=correlation_id,
                )
                if (
                    page["viewer"]["id"] != installation.app_user_id
                    or page["organization"]["id"] != installation.organization_id
                ):
                    raise LinearProjectDiscoveryFailure(
                        "linear_project_discovery_identity_drift", retryable=False
                    )
                for node in page["nodes"]:
                    projects[node["id"]] = LinearProject(
                        project_id=node["id"],
                        organization_id=installation.organization_id,
                        team_id="",
                        name=node["name"],
                        slug=node["slug"],
                    )
                page_info = page["page_info"]
                if not page_info["has_next_page"]:
                    break
                after = page_info["end_cursor"]
                if after in seen_cursors:
                    raise LinearProjectDiscoveryFailure(
                        "linear_project_discovery_pagination_invalid", retryable=False
                    )
                seen_cursors.add(after)
        except LinearGatewayFailure as error:
            code = (
                "linear_project_discovery_authorization_failed"
                if error.code == "linear_gateway_authorization_failed"
                else "linear_project_discovery_upstream_failed"
            )
            self._fail(installation_id, code, error.retryable, correlation_id)
        except LinearProjectDiscoveryFailure as error:
            self._fail(installation_id, error.code, error.retryable, correlation_id)

        try:
            self.repository.replace_projects(
                installation_id,
                projects.values(),
                clear_error_codes=DISCOVERY_ERROR_CODES,
            )
        except ProjectSelectionConflict:
            self._fail(
                installation_id,
                "linear_project_discovery_identity_drift",
                False,
                correlation_id,
            )
        except sqlite3.Error:
            self._fail(
                installation_id,
                "linear_project_discovery_persistence_failed",
                True,
                correlation_id,
            )
        LOGGER.info(
            "event=linear_project_discovery_completed correlation_id=%s "
            "installation_id=%s project_count=%s",
            correlation_id,
            installation_id,
            len(projects),
        )
        return len(projects)

    def _fail(
        self,
        installation_id: str,
        code: str,
        retryable: bool,
        correlation_id: str,
        *,
        record: bool = True,
    ) -> NoReturn:
        self._log_failure(code, retryable, correlation_id, installation_id)
        if record:
            try:
                self.repository.record_error_if_clear_or_owned(
                    installation_id,
                    code,
                    owned_codes=DISCOVERY_ERROR_CODES,
                )
            except (sqlite3.Error, ValueError):
                LOGGER.error(
                    "event=linear_project_discovery_error_record_failed "
                    "correlation_id=%s installation_id=%s "
                    "error_type=linear_project_discovery "
                    "error_code=linear_project_discovery_persistence_failed "
                    "sanitized_reason=linear_project_discovery_persistence_failed "
                    "action_required=true retryable=true next_action=inspect_local_storage",
                    correlation_id,
                    installation_id,
                )
        raise LinearProjectDiscoveryFailure(code, retryable=retryable)

    def _log_failure(
        self,
        code: str,
        retryable: bool,
        correlation_id: str,
        installation_id: str = "unknown",
    ) -> None:
        LOGGER.error(
            "event=linear_project_discovery_failed correlation_id=%s "
            "installation_id=%s error_type=linear_project_discovery error_code=%s "
            "sanitized_reason=%s action_required=%s retryable=%s next_action=%s",
            correlation_id,
            installation_id,
            code,
            code,
            str(not retryable).lower(),
            str(retryable).lower(),
            "retry_project_discovery" if retryable else "inspect_linear_connection",
        )
