from __future__ import annotations

import re
from typing import Any

MAX_PAGE_SIZE = 50
MAX_TEXT = 200
_OPAQUE_ID = re.compile(r"[^\x00-\x1f\x7f]{1,200}")


def validate_projects_variables(variables: object) -> dict[str, Any]:
    if not isinstance(variables, dict) or set(variables) != {"first", "after"}:
        raise ValueError("linear_gateway_variables_invalid")
    first = variables["first"]
    after = variables["after"]
    if isinstance(first, bool) or not isinstance(first, int) or not 1 <= first <= MAX_PAGE_SIZE:
        raise ValueError("linear_gateway_variables_invalid")
    if after is not None and (
        not isinstance(after, str) or _OPAQUE_ID.fullmatch(after) is None
    ):
        raise ValueError("linear_gateway_variables_invalid")
    return {"first": first, "after": after}


def validate_projects_response(data: object, *, first: int) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) != {
        "viewer",
        "organization",
        "projects",
    }:
        raise ValueError("linear_gateway_response_invalid")
    viewer = data["viewer"]
    organization = data["organization"]
    if (
        not isinstance(viewer, dict)
        or set(viewer) != {"id", "app"}
        or not _opaque(viewer["id"])
        or viewer["app"] is not True
        or not isinstance(organization, dict)
        or set(organization) != {"id"}
        or not _opaque(organization["id"])
    ):
        raise ValueError("linear_gateway_response_invalid")
    projects = data["projects"]
    if not isinstance(projects, dict) or set(projects) != {"nodes", "pageInfo"}:
        raise ValueError("linear_gateway_response_invalid")
    nodes = projects["nodes"]
    page_info = projects["pageInfo"]
    if not isinstance(nodes, list) or len(nodes) > first:
        raise ValueError("linear_gateway_response_invalid")
    validated = [_project(node) for node in nodes]
    if not isinstance(page_info, dict) or set(page_info) != {"hasNextPage", "endCursor"}:
        raise ValueError("linear_gateway_response_invalid")
    has_next = page_info["hasNextPage"]
    end_cursor = page_info["endCursor"]
    if not isinstance(has_next, bool) or (
        end_cursor is not None
        and (not isinstance(end_cursor, str) or _OPAQUE_ID.fullmatch(end_cursor) is None)
    ):
        raise ValueError("linear_gateway_response_invalid")
    if has_next and end_cursor is None:
        raise ValueError("linear_gateway_response_invalid")
    return {
        "viewer": {"id": viewer["id"], "app": True},
        "organization": {"id": organization["id"]},
        "nodes": validated,
        "page_info": {"has_next_page": has_next, "end_cursor": end_cursor},
    }


def _project(node: object) -> dict[str, str]:
    if not isinstance(node, dict) or set(node) != {"id", "name", "slugId"}:
        raise ValueError("linear_gateway_response_invalid")
    project_id = node["id"]
    name = node["name"]
    slug = node["slugId"]
    if not _opaque(project_id) or not _opaque(name) or not _opaque(slug):
        raise ValueError("linear_gateway_response_invalid")
    return {"id": project_id, "name": name, "slug": slug}


def _opaque(value: object) -> bool:
    return isinstance(value, str) and _OPAQUE_ID.fullmatch(value) is not None
