from __future__ import annotations

from pathlib import Path


def test_make_stop_stops_conductor_and_managed_performer() -> None:
    makefile = Path("Makefile").read_text(encoding="utf-8")

    assert "$(CONDUCTOR) --port 8081 --data-root ./.conductor" in makefile
    assert "pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.conductor'" in makefile
    assert "pkill -f '$(PERFORMER) .*/.conductor/instances/.*/WORKFLOW.md'" in makefile


def test_make_test_pins_package_src_roots_on_pythonpath() -> None:
    makefile = Path("Makefile").read_text(encoding="utf-8")

    assert "packages/performer-api/src" in makefile
    assert "packages/performer/src" in makefile
    assert "packages/conductor/src" in makefile
    assert "packages/podium/src" in makefile
    assert "$(PIP) uninstall -y symphony-linear-codex" in makefile
    assert "rm -f $(VENV)/bin/symphony" in makefile
    assert "$(PIP) install -e packages/performer-api -e packages/performer[test] -e packages/conductor -e packages/podium" in makefile


def test_readme_real_integration_test_command_pins_repo_src() -> None:
    readme = Path("README.md").read_text(encoding="utf-8")

    assert (
        "PERFORMER_REAL_INTEGRATION=1 LINEAR_API_KEY=... PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src .venv/bin/python -m pytest "
        "tests/test_real_integration.py -q" in readme
    )
