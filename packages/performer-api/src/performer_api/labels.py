from __future__ import annotations

import re


_MANAGED_PROJECT_LABEL = re.compile(r"symphony:conductor/[A-Za-z][A-Za-z0-9]{0,15}-[a-z0-9]{6}")


def managed_project_label_name(name: str, public_id: str) -> str:
    return f"symphony:conductor/{name}-{public_id}"


def is_managed_project_label(value: object) -> bool:
    return isinstance(value, str) and _MANAGED_PROJECT_LABEL.fullmatch(value) is not None


__all__ = ["is_managed_project_label", "managed_project_label_name"]
