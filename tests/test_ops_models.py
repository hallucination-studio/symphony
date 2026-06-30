from symphony.models import RuntimeTokens
from symphony.ops_models import AttemptRecord, TurnRecord


def test_runtime_tokens_include_cached_tokens() -> None:
    tokens = RuntimeTokens(input_tokens=10, output_tokens=4, cached_tokens=3, total_tokens=17)

    assert tokens.cached_tokens == 3
    assert tokens.total_tokens == 17


def test_runtime_tokens_support_new_and_legacy_positional_order() -> None:
    new_order = RuntimeTokens(10, 4, 3, 17)
    legacy_order = RuntimeTokens(10, 4, 14)

    assert new_order.cached_tokens == 3
    assert new_order.total_tokens == 17
    assert legacy_order.cached_tokens == 0
    assert legacy_order.total_tokens == 14


def test_attempt_and_turn_records_capture_contract_fields() -> None:
    attempt = AttemptRecord(
        attempt_id="attempt-1",
        run_id="run-1",
        attempt_number=1,
        status="running",
        codex_session_id="thr_1-turn_1",
    )
    turn = TurnRecord(
        turn_id="turn-1",
        attempt_id="attempt-1",
        turn_number=1,
        status="completed",
        cached_tokens=3,
        total_tokens=17,
    )

    assert attempt.run_id == "run-1"
    assert attempt.codex_session_id == "thr_1-turn_1"
    assert turn.attempt_id == "attempt-1"
    assert turn.cached_tokens == 3
