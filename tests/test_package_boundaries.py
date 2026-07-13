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


def test_provider_sdk_ownership_is_limited_to_performer() -> None:
    forbidden_markers = (
        "openai-codex",
        "openai_codex",
        "asynccodex",
        "codexcontroller",
        "performer_credentials",
        "performercredentialslots",
    )
    for role in ("conductor", "podium"):
        package_root = ROOT / role.replace("_", "-")
        paths = [
            path
            for path in package_root.rglob("*")
            if path.is_file()
            and (
                path.suffix in {".py", ".toml", ".txt", ".lock"}
                or path.name in {"pyproject.toml", "requirements.in", "requirements.txt"}
            )
        ]
        for path in paths:
            text = path.read_text(encoding="utf-8").lower()
            for marker in forbidden_markers:
                assert marker not in text, path
