from __future__ import annotations

import re
import secrets
import string
from typing import Any

from .podium_shared import utc_now_iso


MUSICIAN_NAMES = (
    "Bach",
    "Beethoven",
    "Brahms",
    "Chopin",
    "Debussy",
    "Handel",
    "Haydn",
    "Mahler",
    "Mozart",
    "Paganini",
    "Puccini",
    "Ravel",
    "Rossini",
    "Schubert",
    "Strauss",
    "Vivaldi",
)
CONDUCTOR_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,15}$")
PUBLIC_ID_ALPHABET = string.ascii_lowercase + string.digits


class ConductorIdentityError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumConductorsMixin:
    async def reserve_conductor(self, user_id: str, requested_name: str = "") -> dict[str, Any]:
        conductors = await self.store.list_conductors_for_user(user_id)
        used_names = {str(row.get("name") or "").casefold() for row in conductors}
        name = requested_name.strip() or self._allocate_conductor_name(used_names)
        if not CONDUCTOR_NAME.fullmatch(name):
            raise ConductorIdentityError(
                "invalid_conductor_name",
                "Conductor name must be one ASCII word of at most 16 characters",
            )
        if name.casefold() in used_names:
            raise ConductorIdentityError("conductor_name_taken", "Conductor name is already in use")
        public_id = await self._allocate_conductor_public_id()
        conductor_id = f"conductor_{secrets.token_urlsafe(12)}"
        runtime_group_id = f"group_{conductor_id}"
        conductor = {
            "id": conductor_id,
            "conductor_id": conductor_id,
            "user_id": user_id,
            "runtime_group_id": runtime_group_id,
            "name": name,
            "public_id": public_id,
            "enrollment_state": "pending",
            "hostname": "",
            "label": name,
            "version": "",
            "service_identity": f"symphony-conductor-{public_id}",
            "data_root": "",
            "runtime_token_hash": "",
            "proxy_token_hash": "",
            "disabled": False,
            "revoked": False,
            "created_at": utc_now_iso(),
            "last_report_at": None,
        }
        await self.store.upsert_runtime_group(
            {
                "id": runtime_group_id,
                "linear_workspace_id": user_id,
                "project_slug": "",
                "linear_agent_app_user_id": "",
                "managed_run_profile": "default",
                "project_binding_id": "",
            }
        )
        await self.store.upsert_conductor(conductor)
        return conductor

    async def conductor_for_user(self, conductor_id: str, user_id: str) -> dict[str, Any] | None:
        return next(
            (
                conductor
                for conductor in await self.store.list_conductors_for_user(user_id)
                if str(conductor.get("id") or "") == conductor_id
            ),
            None,
        )

    async def conductor_public(self, conductor: dict[str, Any]) -> dict[str, Any]:
        conductor_id = str(conductor["id"])
        bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        return {
            "id": conductor_id,
            "name": str(conductor.get("name") or ""),
            "public_id": str(conductor.get("public_id") or ""),
            "enrollment_state": str(conductor.get("enrollment_state") or "pending"),
            "hostname": str(conductor.get("hostname") or ""),
            "version": str(conductor.get("version") or ""),
            "service_identity": str(conductor.get("service_identity") or ""),
            "data_root": str(conductor.get("data_root") or ""),
            "online": await self.is_runtime_online(conductor_id),
            "last_report_at": conductor.get("last_report_at"),
            "binding": self.binding_public(bindings[0]) if bindings else None,
        }

    @staticmethod
    def _allocate_conductor_name(used_names: set[str]) -> str:
        for name in MUSICIAN_NAMES:
            if name.casefold() not in used_names:
                return name
        suffix = 2
        while True:
            for name in MUSICIAN_NAMES:
                candidate = f"{name[:16 - len(str(suffix))]}{suffix}"
                if candidate.casefold() not in used_names:
                    return candidate
            suffix += 1

    async def _allocate_conductor_public_id(self) -> str:
        used = {
            str(row.get("public_id") or "")
            for row in await self.store.list_runtime_groups()
            if isinstance(row, dict)
        }
        for conductor in await self.store.list_all_conductors():
            used.add(str(conductor.get("public_id") or ""))
        while True:
            candidate = "".join(secrets.choice(PUBLIC_ID_ALPHABET) for _ in range(6))
            if candidate not in used:
                return candidate
