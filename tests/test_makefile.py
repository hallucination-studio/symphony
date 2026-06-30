from __future__ import annotations

from pathlib import Path


def test_make_stop_stops_conductor_and_managed_symphony() -> None:
    makefile = Path("Makefile").read_text(encoding="utf-8")

    assert "$(CONDUCTOR) --port 8081 --data-root ./.symphony" in makefile
    assert "pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.symphony'" in makefile
    assert "pkill -f '$(SYMPHONY) .*/.symphony/instances/.*/WORKFLOW.md'" in makefile
