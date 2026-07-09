from __future__ import annotations

from typing import Any

from performer_api.managed_runs import WorkItemState

from .conductor_managed_run_store import ConductorManagedRunStore


def ingest_linear_dependency_blocks(
    store: ConductorManagedRunStore,
    run_id: str,
    relations: list[dict[str, Any]],
) -> dict[str, Any]:
    items = store.list_work_items(run_id)
    active_ids = {str(item["work_item_id"]) for item in items if item.get("state") != WorkItemState.CANCELLED.value}
    stored = _stored_dependencies(items, active_ids)
    merged = _merge_linear_edges(_filtered_dependencies(stored, active_ids), _issue_to_work_item(store, run_id), relations, active_ids)
    if _has_cycle(merged):
        return {"applied": False, "reason": "dependency_cycle_rejected"}
    if merged == stored:
        return {"applied": False, "reason": "topology_unchanged"}
    for item in items:
        work_item_id = str(item["work_item_id"])
        if work_item_id not in active_ids:
            continue
        payload = dict(item.get("payload") if isinstance(item.get("payload"), dict) else {})
        payload["dependencies"] = merged.get(work_item_id, [])
        store.update_work_item_payload(run_id, work_item_id, payload)
    return {"applied": True, "reason": "dependencies_updated"}


def _stored_dependencies(items: list[dict[str, Any]], active_ids: set[str]) -> dict[str, list[str]]:
    dependencies: dict[str, list[str]] = {}
    for item in items:
        work_item_id = str(item["work_item_id"])
        if work_item_id not in active_ids:
            continue
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        raw = [str(dependency) for dependency in payload.get("dependencies") or []]
        dependencies[work_item_id] = sorted({dependency for dependency in raw if dependency})
    return dependencies


def _filtered_dependencies(dependencies: dict[str, list[str]], active_ids: set[str]) -> dict[str, list[str]]:
    return {
        work_item_id: sorted({dependency for dependency in raw if dependency in active_ids})
        for work_item_id, raw in dependencies.items()
        if work_item_id in active_ids
    }


def _merge_linear_edges(
    current: dict[str, list[str]],
    issue_to_work_item: dict[str, str],
    relations: list[dict[str, Any]],
    active_ids: set[str],
) -> dict[str, list[str]]:
    merged = {work_item_id: set(dependencies) for work_item_id, dependencies in current.items()}
    for relation in relations:
        if not isinstance(relation, dict) or relation.get("type") != "blocks":
            continue
        blocker = issue_to_work_item.get(str(relation.get("issue_id") or ""))
        blocked = issue_to_work_item.get(str(relation.get("related_issue_id") or ""))
        if blocker in active_ids and blocked in active_ids and blocker != blocked:
            merged.setdefault(blocked, set()).add(blocker)
    return {work_item_id: sorted(dependencies) for work_item_id, dependencies in merged.items()}


def _issue_to_work_item(store: ConductorManagedRunStore, run_id: str) -> dict[str, str]:
    mapped: dict[str, str] = {}
    for projection in store.list_linear_projections(run_id):
        issue_id = str(projection.get("linear_issue_id") or "")
        work_item_id = str(projection.get("work_item_id") or "")
        if issue_id and work_item_id:
            mapped[issue_id] = work_item_id
    return mapped


def _has_cycle(dependencies: dict[str, list[str]]) -> bool:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> bool:
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for dependency in dependencies.get(node, []):
            if visit(dependency):
                return True
        visiting.remove(node)
        visited.add(node)
        return False

    return any(visit(node) for node in dependencies)


__all__ = ["ingest_linear_dependency_blocks"]
