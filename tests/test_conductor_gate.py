from __future__ import annotations

from dataclasses import replace

from performer_api.turns import GateResult

from conductor.gate import AcceptanceGate


def test_gate_requires_commands_and_single_codex_gate(tmp_path, minimal_task) -> None:
    result, evidence = AcceptanceGate().evaluate(
        minimal_task,
        tmp_path,
        GateResult(
            passed=True,
            score=4,
            threshold=3,
            rubric={"correctness": {"score": 4}},
            provenance=[{"source": "codex"}],
        ),
    )

    assert result.passed is False
    assert evidence["commands"][0]["passed"] is False
    assert "verification_command_failed" in result.findings


def test_gate_preserves_score_rubric_and_artifact_provenance(tmp_path, minimal_task) -> None:
    minimal_task = replace(minimal_task, verification_commands=["python3 -c 'print(\"ok\")'"])
    result, evidence = AcceptanceGate().evaluate(
        minimal_task,
        tmp_path,
        GateResult(
            passed=True,
            score=4,
            threshold=3,
            rubric={"correctness": {"score": 4, "weight": 2}},
            provenance=[{"source": "codex", "attempt_id": "attempt-1"}],
            artifact_refs=["artifact://run/task"],
        ),
    )

    assert result.passed is True
    assert result.rubric["correctness"]["weight"] == 2
    assert result.artifact_refs == ["artifact://run/task"]
    assert evidence["commands"][0]["exit_code"] == 0
