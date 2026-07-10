from __future__ import annotations

from typing import Any

from ._postgres_linear import _workspace_installation
from ._postgres_records import _pg_datetime


class PgLinearWebhooksMixin:
    async def list_active_workspace_installations(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_workspace_installations WHERE active = TRUE ORDER BY user_id"
        )
        return [_workspace_installation(row) for row in rows]

    async def find_active_workspace_installation(
        self,
        linear_organization_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM linear_workspace_installations WHERE linear_organization_id = $1 AND active = TRUE",
            linear_organization_id,
        )
        return _workspace_installation(row) if row is not None else None

    async def claim_linear_webhook_delivery(self, delivery: dict[str, Any]) -> bool:
        row = await self.pool.fetchrow(
            """
            INSERT INTO linear_webhook_deliveries (
              delivery_id, installation_id, status, event_key, error_code, received_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz)
            ON CONFLICT (delivery_id) DO NOTHING
            RETURNING delivery_id
            """,
            str(delivery["delivery_id"]),
            str(delivery["installation_id"]),
            str(delivery.get("status") or "received"),
            str(delivery.get("event_key") or ""),
            str(delivery.get("error_code") or ""),
            _pg_datetime(delivery.get("received_at")),
            _pg_datetime(delivery.get("updated_at")),
        )
        return row is not None

    async def save_linear_webhook_delivery(self, delivery: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            UPDATE linear_webhook_deliveries
            SET status = $2, event_key = $3, error_code = $4, updated_at = $5::timestamptz
            WHERE delivery_id = $1
            """,
            str(delivery["delivery_id"]),
            str(delivery.get("status") or "received"),
            str(delivery.get("event_key") or ""),
            str(delivery.get("error_code") or ""),
            _pg_datetime(delivery.get("updated_at")),
        )
