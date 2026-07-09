from __future__ import annotations

from typing import Any

import real_symphony_e2e_linear_actions as _actions
import real_symphony_e2e_linear_core as _core
import real_symphony_e2e_linear_tree as _tree
from real_symphony_e2e_linear_core import linear_graphql


async def fetch_linear_viewer(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_core("fetch_linear_viewer", *args, **kwargs)


async def create_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_core("create_linear_issue", *args, **kwargs)


async def resolve_project(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_core("resolve_project", *args, **kwargs)


async def create_linear_blocks_relation(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("create_linear_blocks_relation", *args, **kwargs)


async def fetch_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("fetch_linear_issue", *args, **kwargs)


async def delegate_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("delegate_linear_issue", *args, **kwargs)


async def wait_for_linear_delegate_visible(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original_graphql = _actions.linear_graphql
    original_fetch = _actions.fetch_linear_issue
    _actions.linear_graphql = linear_graphql
    _actions.fetch_linear_issue = fetch_linear_issue
    try:
        return await _actions.wait_for_linear_delegate_visible(*args, **kwargs)
    finally:
        _actions.linear_graphql = original_graphql
        _actions.fetch_linear_issue = original_fetch


async def comment_linear_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("comment_linear_issue", *args, **kwargs)


async def fetch_linear_human_action_issue(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("fetch_linear_human_action_issue", *args, **kwargs)


async def update_linear_issue_description(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("update_linear_issue_description", *args, **kwargs)


async def move_linear_issue_to_state(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return await _call_actions("move_linear_issue_to_state", *args, **kwargs)


async def fetch_linear_issue_tree(*args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _tree.linear_graphql
    _tree.linear_graphql = linear_graphql
    try:
        return await _tree.fetch_linear_issue_tree(*args, **kwargs)
    finally:
        _tree.linear_graphql = original


async def _call_core(name: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _core.linear_graphql
    _core.linear_graphql = linear_graphql
    try:
        return await getattr(_core, name)(*args, **kwargs)
    finally:
        _core.linear_graphql = original


async def _call_actions(name: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
    original = _actions.linear_graphql
    _actions.linear_graphql = linear_graphql
    try:
        return await getattr(_actions, name)(*args, **kwargs)
    finally:
        _actions.linear_graphql = original
