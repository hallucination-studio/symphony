from __future__ import annotations

import ast
from pathlib import Path


PODIUM_SRC = Path("packages/podium/src/podium")


def _source(relative: str) -> str:
    return (PODIUM_SRC / relative).read_text(encoding="utf-8")


def test_managed_podium_state_has_no_business_memory_collections() -> None:
    tree = ast.parse(_source("app.py"))
    state_class = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "ManagedPodiumState"
    )

    offenders: list[str] = []
    for node in state_class.body:
        if not isinstance(node, ast.AnnAssign):
            continue
        name = node.target.id if isinstance(node.target, ast.Name) else "<unknown>"
        annotation = ast.unparse(node.annotation)
        if annotation.startswith(("dict[", "list[", "set[")):
            offenders.append(name)

    assert offenders == []


def test_podium_runtime_code_has_no_in_memory_business_state_or_redis_fallback() -> None:
    combined = "\n".join(
        _source(path)
        for path in (
            "app.py",
            "podium_state.py",
            "podium_runtime.py",
            "podium_dispatch.py",
            "podium_oauth.py",
            "podium_routes_runtime.py",
        )
    )

    forbidden = [
        "InMemoryPodiumBusinessState",
        "redis_store",
        "RedisStore",
        "self.runtimes",
        "self.sessions",
        "self.dispatches",
        "self.presence",
        "self.runtime_configs",
        "self.pipeline_views",
        "self.ws_queues",
        "state.runtimes",
        "state.dispatches",
        "state.presence",
        "state.runtime_configs",
        "state.pipeline_views",
    ]
    assert [needle for needle in forbidden if needle in combined] == []


def test_postgres_store_has_no_pool_none_memory_fallbacks() -> None:
    source = _source("store/postgres.py")

    assert "_memory_" not in source
    assert "if self.pool is None" not in source
    assert "postgres_pool_unavailable" not in source


def test_json_store_is_the_only_podium_test_state_implementation() -> None:
    init_source = _source("store/__init__.py")
    json_source = _source("store/json_store.py")

    assert "PodiumStore" in init_source
    assert "class PodiumStore" in json_source
    assert "RedisStore" not in init_source
