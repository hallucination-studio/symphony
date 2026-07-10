from __future__ import annotations

import subprocess
from pathlib import Path

from tools.code_size_gate import collect_findings


def test_business_code_stays_below_size_gate() -> None:
    findings = collect_findings(Path.cwd())

    assert findings == [], "\n".join(finding.format() for finding in findings)


def test_code_size_gate_includes_untracked_business_source(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    source = tmp_path / "packages" / "untracked_oversized.py"
    source.parent.mkdir(parents=True)
    source.write_text("\n".join("# source line" for _ in range(351)), encoding="utf-8")

    findings = collect_findings(tmp_path)

    assert any(finding.path == "packages/untracked_oversized.py" and finding.kind == "file" for finding in findings)
