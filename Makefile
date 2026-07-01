VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(PYTHON) -m pip
PERFORMER := $(VENV)/bin/performer
CONDUCTOR := $(VENV)/bin/conductor
PODIUM := $(VENV)/bin/podium
WORKFLOW := WORKFLOW.md

.PHONY: dev stop once test install

dev: install
	$(CONDUCTOR) --port 8081 --data-root ./.conductor

stop:
	-pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.conductor'
	-pkill -f '$(PERFORMER) .*/.conductor/instances/.*/WORKFLOW.md'

once: install
	$(PERFORMER) $(WORKFLOW) --once

test: install
	PYTHONPATH=$(PWD)/packages/performer-api/src:$(PWD)/packages/performer/src:$(PWD)/packages/conductor/src:$(PWD)/packages/podium/src $(PYTHON) -m pytest -q

install:
	python3 -m venv $(VENV)
	-$(PIP) uninstall -y symphony-linear-codex
	-rm -f $(VENV)/bin/symphony
	$(PIP) install -e packages/performer-api -e packages/performer[test] -e packages/conductor -e packages/podium
