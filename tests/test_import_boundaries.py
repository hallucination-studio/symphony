from __future__ import annotations

import ast
from pathlib import Path


ROOTS = {
    "performer_api": Path("packages/performer-api/src/performer_api"),
    "performer": Path("packages/performer/src/performer"),
    "conductor": Path("packages/conductor/src/conductor"),
    "podium": Path("packages/podium/src/podium"),
}


def _imports(root: Path) -> set[str]:
    found: set[str] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                found.add(node.module.split(".", 1)[0])
    return found


def test_package_import_boundaries() -> None:
    imports = {name: _imports(path) for name, path in ROOTS.items()}

    assert not (imports["performer_api"] & {"performer", "conductor", "podium"})
    assert not (imports["performer"] & {"conductor", "podium"})
    assert not (imports["conductor"] & {"performer", "podium"})
    assert not (imports["podium"] & {"performer", "conductor"})
    assert "performer_api" in imports["performer"]
    assert "performer_api" in imports["conductor"]
    assert "performer_api" in imports["podium"]
