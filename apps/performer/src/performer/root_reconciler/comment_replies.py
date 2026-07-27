from __future__ import annotations

from hashlib import sha256
from typing import Any


def pending_comment_reply_sources_from_snapshot(
    snapshot: dict[str, Any],
    pending_input_ids: list[str],
) -> list[dict[str, Any]]:
    pending = set(pending_input_ids)
    sources: list[dict[str, Any]] = []
    user_comments = _objects(snapshot.get("user_comments"))
    user_comment_ids = {
        comment_id
        for comment in user_comments
        if isinstance(comment_id := comment.get("comment_id"), str)
    }
    for comment in user_comments:
        source = _body_source(comment)
        if source is not None and source["source_input_id"] in pending:
            sources.append(source)
    for thread_state in _objects(snapshot.get("user_comment_thread_states")):
        if thread_state.get("comment_id") not in user_comment_ids:
            continue
        source = _thread_state_source(thread_state)
        if source is not None and source["source_input_id"] in pending:
            sources.append(source)
    return sorted(sources, key=lambda source: source["source_input_id"])


def pending_comment_reply_sources_from_request(request: dict[str, Any]) -> list[dict[str, Any]]:
    if request.get("kind") == "open_root_reconciler":
        bootstrap = request.get("bootstrap")
        if not isinstance(bootstrap, dict):
            return []
        snapshot = bootstrap.get("root_snapshot")
        pending = bootstrap.get("pending_input_ids")
        if not isinstance(snapshot, dict) or not _identifiers(pending):
            return []
        return pending_comment_reply_sources_from_snapshot(snapshot, pending)

    delta = request.get("delta")
    if not isinstance(delta, dict):
        return []
    pending = delta.get("pending_input_ids")
    if not _identifiers(pending):
        return []
    sources: list[dict[str, Any]] = []
    for change in _objects(delta.get("changes")):
        source = _delta_source(change)
        if source is not None and source["source_input_id"] in pending:
            sources.append(source)
    return sorted(sources, key=lambda source: source["source_input_id"])


def _delta_source(change: dict[str, Any]) -> dict[str, Any] | None:
    if change.get("kind") == "tombstone":
        return None
    context_value = change.get("value")
    if not isinstance(context_value, dict):
        return None
    if context_value.get("kind") == "comment":
        value = context_value.get("user_input")
        if isinstance(value, dict):
            return _body_source(value, input_id=value.get("input_id"))
    if context_value.get("kind") == "comment_thread":
        value = context_value.get("thread_state")
        if isinstance(value, dict):
            return _thread_state_source(value)
    return None


def _body_source(value: dict[str, Any], *, input_id: object | None = None) -> dict[str, Any] | None:
    comment_id = value.get("comment_id")
    digest = value.get("comment_body_digest")
    if not isinstance(digest, str):
        body = value.get("body")
        if not isinstance(body, str):
            return None
        digest = sha256(body.encode("utf-8")).hexdigest()
    if not _identifier(comment_id) or not _identifier(digest):
        return None
    source_input_id = input_id if isinstance(input_id, str) else _root_input_id(f"comment_body:{comment_id}", digest)
    if not _identifier(source_input_id):
        return None
    return {
        "source_input_id": source_input_id,
        "source": {
            "kind": "comment_body",
            "comment_id": comment_id,
            "comment_body_digest": digest,
        },
    }


def _thread_state_source(value: dict[str, Any]) -> dict[str, Any] | None:
    comment_id = value.get("comment_id")
    remote_version = value.get("comment_remote_version")
    thread_root_comment_id = value.get("thread_root_comment_id")
    thread_state = value.get("thread_state")
    if (
        not _identifier(comment_id)
        or not _identifier(remote_version)
        or not _identifier(thread_root_comment_id)
        or thread_state not in {"resolved", "unresolved"}
    ):
        return None
    return {
        "source_input_id": _root_input_id(
            f"comment_thread_state:{comment_id}:{thread_root_comment_id}:{thread_state}",
            remote_version,
        ),
        "source": {
            "kind": "comment_thread_state",
            "comment_id": comment_id,
            "comment_remote_version": remote_version,
            "thread_root_comment_id": thread_root_comment_id,
            "thread_state": thread_state,
        },
    }


def _root_input_id(source_id: str, source_version: str) -> str:
    return f"input:{sha256(f'{source_id}\0{source_version}'.encode('utf-8')).hexdigest()}"


def _objects(value: object) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _identifiers(value: object) -> bool:
    return isinstance(value, list) and all(_identifier(item) for item in value)


def _identifier(value: object) -> bool:
    return isinstance(value, str) and bool(value)
