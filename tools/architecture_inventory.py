from __future__ import annotations

import ast
import importlib.util
import json
from importlib.metadata import distribution
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROLE_ROOTS = {
    "performer": Path("packages/performer/src/performer"),
    "conductor": Path("packages/conductor/src/conductor"),
    "podium": Path("packages/podium/src/podium"),
}


def build_inventory(root: Path = ROOT) -> dict[str, object]:
    roles = {role: _role_inventory(root, role) for role in ROLE_ROOTS}
    errors = [
        f"{role}_unreachable_modules"
        for role, details in roles.items()
        if details["unreachable"]
    ]
    return {"roles": roles, "errors": errors, "pass": not errors}


def _role_inventory(root: Path, role: str) -> dict[str, object]:
    modules = _module_paths(root / ROLE_ROOTS[role], role)
    entrypoint = _installed_entrypoint(role)
    entry_module = entrypoint.partition(":")[0]
    if entry_module not in modules:
        raise RuntimeError(f"entrypoint_module_missing:{role}:{entry_module}")
    reachable = {entry_module}
    pending = [entry_module]
    while pending:
        module = pending.pop()
        for imported in _internal_imports(module, modules[module], set(modules)):
            if imported not in reachable:
                reachable.add(imported)
                pending.append(imported)
    return {
        "entrypoint": entrypoint,
        "modules": sorted(modules),
        "reachable": sorted(reachable),
        "unreachable": sorted(set(modules) - reachable),
    }


def _module_paths(package_root: Path, role: str) -> dict[str, Path]:
    modules: dict[str, Path] = {}
    for path in package_root.rglob("*.py"):
        relative = path.relative_to(package_root)
        parts = relative.parts[:-1] if relative.name == "__init__.py" else (*relative.parts[:-1], relative.stem)
        modules[".".join((role, *parts))] = path
    return modules


def _installed_entrypoint(role: str) -> str:
    matches = [
        entry.value
        for entry in distribution(role).entry_points
        if entry.group == "console_scripts" and entry.name == role
    ]
    if len(matches) != 1:
        raise RuntimeError(f"installed_entrypoint_count:{role}:{len(matches)}")
    return matches[0]


def _internal_imports(module: str, path: Path, known_modules: set[str]) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    package = module if path.name == "__init__.py" else module.rpartition(".")[0]
    imported: set[str] = set()

    def include(name: str) -> None:
        candidate = name
        while candidate:
            if candidate in known_modules:
                imported.add(candidate)
            candidate = candidate.rpartition(".")[0]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                include(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = importlib.util.resolve_name("." * node.level + (node.module or ""), package) if node.level else node.module or ""
            include(base)
            for alias in node.names:
                include(f"{base}.{alias.name}")
    return imported


def main() -> int:
    result = build_inventory()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
