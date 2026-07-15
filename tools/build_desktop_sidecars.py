from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


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


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    target_triple = args.target_triple or rust_host_triple()
    output_dir = args.output_dir or (
        repo_root / "packages/podium/desktop/src-tauri/binaries"
    )
    output_name = f"podium-{target_triple}"
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="podium-sidecar-build-") as temp_dir:
        temp_root = Path(temp_dir)
        entrypoint = temp_root / "podium_desktop_entry.py"
        entrypoint.write_text(
            "from podium.desktop_cli import main\nraise SystemExit(main())\n",
            encoding="utf-8",
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "PyInstaller",
                "--clean",
                "--onefile",
                "--name",
                output_name,
                "--distpath",
                str(temp_root / "dist"),
                "--workpath",
                str(temp_root / "work"),
                "--specpath",
                str(temp_root / "spec"),
                "--paths",
                str(repo_root / "packages/podium/src"),
                str(entrypoint),
            ],
            check=True,
            cwd=repo_root,
        )
        shutil.copy2(temp_root / "dist" / output_name, output_dir / output_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
