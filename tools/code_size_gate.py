from __future__ import annotations

import argparse
import ast
import re
from dataclasses import dataclass
from pathlib import Path


BUSINESS_ROOTS = ("packages", "tools")
EXTENSIONS = {".py", ".ts", ".tsx"}
EXCLUDED_PARTS = {".venv", "__pycache__", "node_modules", "static"}
EXCLUDED_SUFFIXES = (".test.py", ".test.ts", ".test.tsx", ".d.ts")

MAX_FILE_LINES = 350
MAX_FUNCTION_LINES = 80
MAX_CLASS_LINES = 350

FILE_ALLOWLIST: dict[str, int] = {}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    kind: str
    name: str
    lines: int
    limit: int

    def format(self) -> str:
        location = self.path if self.line <= 0 else f"{self.path}:{self.line}"
        name = f" {self.name}" if self.name else ""
        return f"{location} {self.kind}{name} has {self.lines} lines, limit {self.limit}"


def business_source_files(repo: Path) -> list[Path]:
    paths: list[Path] = []
    for root_name in BUSINESS_ROOTS:
        root = repo / root_name
        if not root.is_dir():
            continue
        for source in root.rglob("*"):
            if not source.is_file():
                continue
            path = source.relative_to(repo)
            text_path = str(path)
            if path.suffix not in EXTENSIONS:
                continue
            if any(part in EXCLUDED_PARTS for part in path.parts):
                continue
            if text_path.endswith(EXCLUDED_SUFFIXES):
                continue
            paths.append(path)
    return sorted(paths)


def file_findings(repo: Path, path: Path) -> list[Finding]:
    lines = _read_lines(repo / path)
    limit = FILE_ALLOWLIST.get(str(path), MAX_FILE_LINES)
    if len(lines) <= limit:
        return []
    return [Finding(str(path), 0, "file", "", len(lines), limit)]


def python_findings(repo: Path, path: Path) -> list[Finding]:
    source = (repo / path).read_text(encoding="utf-8")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [Finding(str(path), exc.lineno or 1, "syntax", "", 1, 0)]
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            _append_node_finding(findings, path, node, "function", MAX_FUNCTION_LINES)
        elif isinstance(node, ast.ClassDef):
            _append_node_finding(findings, path, node, "class", MAX_CLASS_LINES)
    return findings


def ts_findings(repo: Path, path: Path) -> list[Finding]:
    lines = _read_lines(repo / path)
    findings: list[Finding] = []
    for index, line in enumerate(lines):
        match = _TS_DECLARATION.match(line)
        if not match:
            continue
        kind = "class" if match.group("class_name") else "function"
        name = match.group("class_name") or match.group("function_name") or match.group("const_name") or "<anonymous>"
        length = _ts_block_length(lines, index)
        limit = MAX_CLASS_LINES if kind == "class" else MAX_FUNCTION_LINES
        if length > limit:
            findings.append(Finding(str(path), index + 1, kind, name, length, limit))
    return findings


def collect_findings(repo: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in business_source_files(repo):
        findings.extend(file_findings(repo, path))
        if path.suffix == ".py":
            findings.extend(python_findings(repo, path))
        else:
            findings.extend(ts_findings(repo, path))
    return sorted(findings, key=lambda item: (item.path, item.line, item.kind))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check Symphony business-code size limits.")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--check", action="store_true", help="Fail when size findings exist.")
    parser.add_argument("--report", action="store_true", help="Print findings without changing files.")
    args = parser.parse_args(argv)

    findings = collect_findings(args.repo.resolve())
    if args.report or args.check:
        for finding in findings:
            print(finding.format())
        print(f"{len(findings)} size finding(s)")
    return 1 if args.check and findings else 0


def _append_node_finding(
    findings: list[Finding],
    path: Path,
    node: ast.AST,
    kind: str,
    limit: int,
) -> None:
    start = int(getattr(node, "lineno", 1))
    end = int(getattr(node, "end_lineno", start))
    length = end - start + 1
    if length > limit:
        findings.append(Finding(str(path), start, kind, str(getattr(node, "name", "")), length, limit))


def _read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


_TS_DECLARATION = re.compile(
    r"^\s*(?:export\s+)?(?:(?:async\s+)?function\s+(?P<function_name>[A-Za-z0-9_]+)"
    r"|class\s+(?P<class_name>[A-Za-z0-9_]+)"
    r"|(?:const|let)\s+(?P<const_name>[A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>)"
)


def _ts_block_length(lines: list[str], start_index: int) -> int:
    depth = 0
    started = False
    for index in range(start_index, len(lines)):
        depth += lines[index].count("{") - lines[index].count("}")
        started = started or "{" in lines[index]
        if started and depth <= 0:
            return index - start_index + 1
    return len(lines) - start_index


if __name__ == "__main__":
    raise SystemExit(main())
