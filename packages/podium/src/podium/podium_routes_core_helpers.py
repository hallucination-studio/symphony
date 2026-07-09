from __future__ import annotations

from typing import Any


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    linear_app = user.get("linear_app") if isinstance(user, dict) else None
    if linear_app:
        public_app: dict[str, Any] | None = {
            "client_id": str(linear_app.get("client_id") or ""),
            "redirect_uri": str(linear_app.get("redirect_uri") or ""),
            "configured": True,
        }
    else:
        public_app = None
    user_id = str(user["id"])
    return {"id": user_id, "email": str(user["email"]), "linear_app": public_app}
