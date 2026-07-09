from __future__ import annotations

from pathlib import Path

from tools.code_size_gate import collect_findings


def test_business_code_stays_below_size_gate() -> None:
    findings = collect_findings(Path.cwd())

    assert findings == [], "\n".join(finding.format() for finding in findings)
