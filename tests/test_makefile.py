from __future__ import annotations

from pathlib import Path


def test_make_stop_stops_conductor_and_managed_symphony() -> None:
    makefile = Path("Makefile").read_text(encoding="utf-8")

    assert "$(CONDUCTOR) --port 8081 --data-root ./.symphony" in makefile
    assert "pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.symphony'" in makefile
    assert "pkill -f '$(SYMPHONY) .*/.symphony/instances/.*/WORKFLOW.md'" in makefile


def test_make_test_pins_repo_src_on_pythonpath() -> None:
    makefile = Path("Makefile").read_text(encoding="utf-8")

    assert "PYTHONPATH=$(PWD)/src $(PYTHON) -m pytest -q" in makefile


def test_readme_real_integration_test_command_pins_repo_src() -> None:
    readme = Path("README.md").read_text(encoding="utf-8")

    assert (
        "SYMPHONY_REAL_INTEGRATION=1 LINEAR_API_KEY=... PYTHONPATH=$(pwd)/src .venv/bin/python -m pytest "
        "tests/test_real_integration.py -q" in readme
    )
