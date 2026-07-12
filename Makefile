VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(PYTHON) -m pip
PERFORMER := $(VENV)/bin/performer
CONDUCTOR := $(VENV)/bin/conductor
PODIUM := $(VENV)/bin/podium
PYTHONPATH_ALL := $(PWD)/packages/performer-api/src:$(PWD)/packages/performer/src:$(PWD)/packages/conductor/src:$(PWD)/packages/podium/src

.PHONY: dev stop once test test-all install

dev: install
	$(CONDUCTOR) --port 8081 --data-root ./.conductor

stop:
	-pkill -f '$(CONDUCTOR) --port 8081 --data-root ./.conductor'
	-pkill -f '$(PERFORMER) --turn-request-path '

once: install
	@echo "make once has been removed; pipeline attempts are leased and started by Conductor."
	@false

test:
	PYTHONPATH=$(PYTHONPATH_ALL) $(PYTHON) -m pytest -q

test-all: install
	PYTHONPATH=$(PYTHONPATH_ALL) $(PYTHON) -m pytest -q

install:
	@test -x $(PYTHON) || python3 -m venv $(VENV)
	$(PIP) install -e packages/performer-api -e packages/performer[test] -e packages/conductor -e packages/podium
