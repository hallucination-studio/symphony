from __future__ import annotations

from typing import Any


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(user["id"]), "email": str(user["email"])}
