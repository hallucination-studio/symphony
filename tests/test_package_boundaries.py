from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).parents[1] / "packages"
ROLES = {"performer_api", "performer", "conductor", "podium"}


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".", 1)[0])
    return names


def test_role_import_boundaries() -> None:
    forbidden = {"performer_api": {"performer", "conductor", "podium"}}
    for role in ROLES:
        source = ROOT / role.replace("_", "-") / "src" / role
        imported = set().union(*(_imports(path) for path in source.rglob("*.py")))
        assert not imported.intersection(forbidden.get(role, set())), role
        if role != "performer_api":
            assert not imported.intersection(ROLES - {"performer_api", role}), role
