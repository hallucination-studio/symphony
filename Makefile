VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(PYTHON) -m pip
SYMPHONY := $(VENV)/bin/symphony
CONDUCTOR := $(VENV)/bin/conductor
WORKFLOW := WORKFLOW.md

.PHONY: dev stop once test install

dev: install
	$(CONDUCTOR) --port 8081 --data-root ./.symphony

stop:
	-pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.symphony'
	-pkill -f '$(SYMPHONY) .*/.symphony/instances/.*/WORKFLOW.md'

once: install
	$(SYMPHONY) $(WORKFLOW) --once

test: install
	$(PYTHON) -m pytest -q

install: $(SYMPHONY) $(CONDUCTOR)

$(SYMPHONY) $(CONDUCTOR): pyproject.toml
	python3 -m venv $(VENV)
	$(PIP) install -e '.[test]'
