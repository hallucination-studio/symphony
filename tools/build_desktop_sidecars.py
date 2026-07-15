from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple


class Sidecar(NamedTuple):
    name: str
    entrypoint: str
    package_path: str
    collected_packages: tuple[str, ...] = ()
    collected_data_packages: tuple[str, ...] = ()


SIDECARS = (
    Sidecar(
        "podium",
        "podium.desktop_cli:main",
        "packages/podium/src",
        collected_data_packages=("podium",),
    ),
    Sidecar("conductor", "conductor.conductor_cli:main", "packages/conductor/src"),
    Sidecar(
        "performer",
        "performer.cli:main",
        "packages/performer/src",
        ("performer", "openai_codex"),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build target-specific Podium Desktop sidecars.")
    parser.add_argument("--target-triple")
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def rust_host_triple() -> str:
    result = subprocess.run(
        ["rustc", "-vV"],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("host: "):
            return line.removeprefix("host: ")
    raise RuntimeError("rust_host_triple_missing")


def build_sidecars(repo_root: Path, output_dir: Path, target_triple: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    shared_path = repo_root / "packages/performer-api/src"

    with tempfile.TemporaryDirectory(prefix="podium-sidecar-build-") as temp_dir:
        temp_root = Path(temp_dir)
        for sidecar in SIDECARS:
            module, function = sidecar.entrypoint.split(":", maxsplit=1)
            entrypoint = temp_root / f"{sidecar.name}_desktop_entry.py"
            entrypoint.write_text(
                f"from {module} import {function}\nraise SystemExit({function}())\n",
                encoding="utf-8",
            )
            output_name = f"{sidecar.name}-{target_triple}"
            dist_path = temp_root / f"dist-{sidecar.name}"
            command = [
                sys.executable,
                "-m",
                "PyInstaller",
                "--clean",
                "--onefile",
                "--name",
                output_name,
                "--distpath",
                str(dist_path),
                "--workpath",
                str(temp_root / f"work-{sidecar.name}"),
                "--specpath",
                str(temp_root / f"spec-{sidecar.name}"),
                "--paths",
                str(repo_root / sidecar.package_path),
                "--paths",
                str(shared_path),
            ]
            for package in sidecar.collected_packages:
                command.extend(("--collect-all", package))
            for package in sidecar.collected_data_packages:
                command.extend(("--collect-data", package))
            command.append(str(entrypoint))
            subprocess.run(
                command,
                check=True,
                cwd=repo_root,
            )
            shutil.copy2(dist_path / output_name, output_dir / output_name)


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    target_triple = args.target_triple or rust_host_triple()
    output_dir = args.output_dir or (
        repo_root / "packages/podium/desktop/src-tauri/binaries"
    )
    build_sidecars(repo_root, output_dir, target_triple)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
