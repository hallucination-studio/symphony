from __future__ import annotations

from types import SimpleNamespace

from conductor.conductor_managed_run_attempts import active_attempt_records, attempt_integrity_errors, canonical_attempt_records, next_attempt_number
from conductor.conductor_managed_run_driver_helpers import _attempt_paths


def test_terminal_attempt_is_not_exposed_as_running_and_is_reported_as_invalid_state() -> None:
    payload = {
        "completed_attempts": [{"attempt_id": "execute-1", "state": "succeeded", "kind": "work_item", "work_item_id": "wi-1"}],
        "active_attempts": [{"attempt_id": "execute-1", "state": "running", "kind": "work_item", "work_item_id": "wi-1"}],
    }

    assert active_attempt_records(payload) == []
    assert canonical_attempt_records(payload) == [payload["completed_attempts"][0]]
    assert attempt_integrity_errors(payload) == ["active_attempt_already_terminal:execute-1"]


def test_next_attempt_number_advances_from_terminal_and_active_attempts() -> None:
    payload = {
        "completed_attempts": [{"attempt_id": "execute-1", "attempt_number": "1", "state": "failed", "kind": "work_item", "work_item_id": "wi-1"}],
        "active_attempts": [{"attempt_id": "execute-2", "attempt_number": "2", "state": "running", "kind": "work_item", "work_item_id": "wi-1"}],
    }

    assert next_attempt_number(payload, kind="work_item", work_item_id="wi-1") == 3


def test_attempt_paths_assigns_a_new_id_and_result_path_for_retry(tmp_path) -> None:
    instance = SimpleNamespace(instance_dir=str(tmp_path / "instance"))
    run = {"run_id": "run-1", "payload": {}}
    first = _attempt_paths(instance, run, "work_item", "wi-1")
    run["payload"] = {
        "completed_attempts": [
            {
                "attempt_id": first["attempt_id"],
                "attempt_number": first["attempt_number"],
                "state": "failed",
                "kind": "work_item",
                "work_item_id": "wi-1",
            }
        ]
    }

    second = _attempt_paths(instance, run, "work_item", "wi-1")

    assert first["attempt_id"] != second["attempt_id"]
    assert first["result_path"] != second["result_path"]
    assert second["attempt_number"] == 2
