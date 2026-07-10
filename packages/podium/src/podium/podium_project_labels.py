from __future__ import annotations

import logging
from typing import Any

from .linear_graphql_client import LinearGraphQLRequestError, execute_linear_graphql


LOGGER = logging.getLogger(__name__)

LABEL_LOOKUP = """
query ManagedProjectLabelLookup($name: String!) {
  projectLabels(first: 1, filter: {name: {eq: $name}}) {
    nodes { id name }
  }
}
"""
LABEL_CREATE = """
mutation ManagedProjectLabelCreate($name: String!) {
  projectLabelCreate(input: {name: $name}) {
    success
    projectLabel { id name }
  }
}
"""
PROJECT_ADD_LABEL = """
mutation ManagedProjectAddLabel($projectId: String!, $labelId: String!) {
  projectAddLabel(id: $projectId, labelId: $labelId) { success }
}
"""
LABEL_UPDATE = """
mutation ManagedProjectLabelUpdate($labelId: String!, $name: String!) {
  projectLabelUpdate(id: $labelId, input: {name: $name}) {
    success
    projectLabel { id name }
  }
}
"""


class LinearProjectLabelError(RuntimeError):
    pass


class PodiumProjectLabelsMixin:
    async def ensure_managed_project_label(self, binding: dict[str, Any]) -> dict[str, Any]:
        conductor = await self.store.get_runtime(str(binding.get("conductor_id") or ""))
        if conductor is None:
            raise LinearProjectLabelError("conductor_not_found")
        label_name = managed_project_label_name(conductor)
        if binding.get("label_id") and binding.get("label_name") == label_name:
            return binding
        installation = await self.get_active_linear_installation(str(binding.get("user_id") or ""))
        if installation is None or str(installation.get("id") or "") != str(binding.get("installation_id") or ""):
            raise LinearProjectLabelError("active_linear_installation_mismatch")
        try:
            label_id = await self._find_or_create_project_label(installation, label_name)
            await self._attach_project_label(installation, binding, label_id)
        except (LinearGraphQLRequestError, LinearProjectLabelError) as exc:
            _log_label_failure(binding, exc)
            raise LinearProjectLabelError("linear_project_label_sync_failed") from exc
        return {**binding, "label_id": label_id, "label_name": label_name}

    async def rename_managed_project_label(
        self,
        binding: dict[str, Any],
        conductor: dict[str, Any],
    ) -> dict[str, Any]:
        label_id = str(binding.get("label_id") or "")
        label_name = managed_project_label_name(conductor)
        if not label_id:
            raise LinearProjectLabelError("linear_project_label_required")
        if str(binding.get("label_name") or "") == label_name:
            return binding
        installation = await self.get_active_linear_installation(str(binding.get("user_id") or ""))
        if installation is None or str(installation.get("id") or "") != str(binding.get("installation_id") or ""):
            raise LinearProjectLabelError("active_linear_installation_mismatch")
        try:
            data = await self._project_label_graphql(
                installation,
                LABEL_UPDATE,
                {"labelId": label_id, "name": label_name},
                "ManagedProjectLabelUpdate",
            )
            payload = data.get("projectLabelUpdate")
            label = payload.get("projectLabel") if isinstance(payload, dict) else None
            if (
                not isinstance(payload, dict)
                or payload.get("success") is not True
                or not isinstance(label, dict)
                or str(label.get("id") or "") != label_id
                or str(label.get("name") or "") != label_name
            ):
                raise LinearProjectLabelError("linear_project_label_update_invalid")
        except (LinearGraphQLRequestError, LinearProjectLabelError) as exc:
            _log_label_rename_failure(binding, exc)
            raise LinearProjectLabelError("linear_project_label_rename_failed") from exc
        return {
            **binding,
            "label_name": label_name,
            "error_code": "",
            "sanitized_reason": "",
        }

    async def _find_or_create_project_label(
        self,
        installation: dict[str, Any],
        label_name: str,
    ) -> str:
        lookup = await self._project_label_graphql(
            installation,
            LABEL_LOOKUP,
            {"name": label_name},
            "ManagedProjectLabelLookup",
        )
        nodes = ((lookup.get("projectLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("name") == label_name and node.get("id"):
                return str(node["id"])
        created = await self._project_label_graphql(
            installation,
            LABEL_CREATE,
            {"name": label_name},
            "ManagedProjectLabelCreate",
        )
        payload = created.get("projectLabelCreate")
        label = payload.get("projectLabel") if isinstance(payload, dict) else None
        if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(label, dict):
            raise LinearProjectLabelError("linear_project_label_create_invalid")
        label_id = str(label.get("id") or "")
        if not label_id or str(label.get("name") or "") != label_name:
            raise LinearProjectLabelError("linear_project_label_create_invalid")
        return label_id

    async def _attach_project_label(
        self,
        installation: dict[str, Any],
        binding: dict[str, Any],
        label_id: str,
    ) -> None:
        data = await self._project_label_graphql(
            installation,
            PROJECT_ADD_LABEL,
            {"projectId": str(binding.get("linear_project_id") or ""), "labelId": label_id},
            "ManagedProjectAddLabel",
        )
        payload = data.get("projectAddLabel")
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise LinearProjectLabelError("linear_project_add_label_invalid")

    async def _project_label_graphql(
        self,
        installation: dict[str, Any],
        query: str,
        variables: dict[str, Any],
        operation_name: str,
    ) -> dict[str, Any]:
        return await execute_linear_graphql(
            access_token=str(installation.get("access_token") or ""),
            query=query,
            variables=variables,
            operation_name=operation_name,
            transport=self.linear_graphql_transport,
        )


def managed_project_label_name(conductor: dict[str, Any]) -> str:
    return f"symphony:conductor/{conductor.get('name')}-{conductor.get('public_id')}"


def _log_label_failure(binding: dict[str, Any], error: Exception) -> None:
    LOGGER.error(
        "event=linear_project_label_sync_failed conductor_id=%s instance_id=%s linear_project_id=%s "
        "error_type=%s error_code=linear_project_label_sync_failed sanitized_reason=%s "
        "action_required=retry retryable=true next_action=retry_project_binding_report",
        binding.get("conductor_id"),
        binding.get("instance_id"),
        binding.get("linear_project_id"),
        type(error).__name__,
        "Linear project label operation failed",
    )


def _log_label_rename_failure(binding: dict[str, Any], error: Exception) -> None:
    LOGGER.error(
        "event=linear_project_label_rename_failed conductor_id=%s instance_id=%s linear_project_id=%s "
        "error_type=%s error_code=linear_project_label_rename_failed sanitized_reason=%s "
        "action_required=retry retryable=true next_action=retry_conductor_rename",
        binding.get("conductor_id"),
        binding.get("instance_id"),
        binding.get("linear_project_id"),
        type(error).__name__,
        "Linear project label rename failed",
    )
