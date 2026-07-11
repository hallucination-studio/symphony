from __future__ import annotations

import ast
from dataclasses import MISSING
import importlib.util
import inspect
from pathlib import Path

from podium.app import ManagedPodiumState, create_app
from podium import store as podium_store


PODIUM_SRC = Path("packages/podium/src/podium")
ADR = Path("docs/decisions/0002-capability-modules-and-release-acceptance.md")
JSON_STORE_MODULES = (
    "json_store",
    "json_store_auth",
    "json_store_base",
    "json_store_dispatch",
    "json_store_legacy",
    "json_store_linear",
    "json_store_ops",
    "json_store_runtime",
)


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
            "podium_linear_installations.py",
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


def test_podium_json_store_modules_are_retired() -> None:
    importlib.invalidate_caches()

    paths = sorted((PODIUM_SRC / "store").glob("json_store*.py"))
    specs = [importlib.util.find_spec(f"podium.store.{name}") for name in JSON_STORE_MODULES]

    assert [str(path) for path in paths] == []
    assert specs == [None] * len(JSON_STORE_MODULES)


def test_podium_store_exports_only_postgresql() -> None:
    assert podium_store.__all__ == ["PgMigrator", "PgStore"]
    assert not hasattr(podium_store, "PodiumStore")


def test_podium_app_requires_an_explicit_store_without_json_data_dir() -> None:
    signature = inspect.signature(create_app)

    assert signature.parameters["store"].default is inspect.Parameter.empty
    assert "data_dir" not in signature.parameters
    assert "data_dir" not in ManagedPodiumState.__dataclass_fields__
    assert ManagedPodiumState.__dataclass_fields__["store"].default is MISSING


def test_json_store_only_config_and_datetime_helpers_are_retired() -> None:
    cli_source = _source("cli.py")
    shared_source = _source("podium_shared.py")

    assert "PODIUM_DATA_DIR" not in cli_source
    assert "_datetime_to_json" not in shared_source
    assert "_datetime_from_json" not in shared_source


def test_adr_uses_postgresql_as_the_only_podium_persistence_adapter() -> None:
    source = ADR.read_text(encoding="utf-8")
    normalized = " ".join(source.split())
    forbidden = (
        "JSON and PostgreSQL storage",
        "PostgreSQL/JSON storage",
        "JSON and PostgreSQL adapters",
        "JSON/PostgreSQL adapters",
        "JSON and PostgreSQL repositories",
        "Is JSON storage retained",
    )

    assert [phrase for phrase in forbidden if phrase in source] == []
    assert (
        "Podium's installed composition uses PostgreSQL as its only persistence adapter."
        in normalized
    )
    assert (
        "higher layers use narrow fakes only at their owned boundary."
        in normalized
    )


def test_production_tests_and_tools_do_not_depend_on_retired_json_store_or_app_defaults() -> None:
    offenders: list[str] = []
    this_file = Path(__file__).resolve()
    paths = (
        sorted(PODIUM_SRC.rglob("*.py"))
        + sorted(Path("tests").rglob("*.py"))
        + sorted(Path("tools").rglob("*.py"))
    )
    for path in paths:
        if path.resolve() == this_file or not path.exists():
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module.startswith("podium.store.json_store") or (
                    node.level > 0 and module.startswith("json_store")
                ):
                    offenders.append(
                        f"{path}:{node.lineno}: imports production JSON store module"
                    )
                for alias in node.names:
                    if (
                        alias.name == "PodiumStore"
                        or alias.name.startswith("JsonStore")
                        or (node.level > 0 and alias.name.startswith("json_store"))
                    ):
                        offenders.append(
                            f"{path}:{node.lineno}: imports {alias.name}"
                        )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("podium.store.json_store"):
                        offenders.append(
                            f"{path}:{node.lineno}: imports production JSON store module"
                        )
            elif isinstance(node, ast.Name) and (
                node.id == "PodiumStore" or node.id.startswith("JsonStore")
            ):
                offenders.append(f"{path}:{node.lineno}: references {node.id}")
            elif isinstance(node, ast.Attribute) and (
                node.attr == "PodiumStore" or node.attr.startswith("JsonStore")
            ):
                offenders.append(f"{path}:{node.lineno}: references {node.attr}")
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and (
                    "podium.store.json_store" in node.value
                    or node.value.lstrip(".").startswith("json_store")
                )
            ):
                offenders.append(
                    f"{path}:{node.lineno}: dynamically references production JSON store module"
                )
            if not isinstance(node, ast.Call):
                continue
            function_name = (
                node.func.id
                if isinstance(node.func, ast.Name)
                else node.func.attr
                if isinstance(node.func, ast.Attribute)
                else ""
            )
            if function_name != "create_app":
                continue
            if not any(keyword.arg == "store" for keyword in node.keywords):
                offenders.append(f"{path}:{node.lineno}: create_app has no explicit store")

    assert offenders == []
