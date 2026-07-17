VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(PYTHON) -m pip

.PHONY: install build lint typecheck test test-all dev stop

install:
	npm install
	@test -x $(PYTHON) || python3 -m venv $(VENV)
	$(PIP) install -e packages/contracts
	$(PIP) install -e 'apps/performer[test,build]'

build: install
	npm run build
	cd apps/podium-desktop/src-tauri && cargo build

lint: install
	npm run lint
	cd apps/podium-desktop/src-tauri && cargo fmt --check
	cd apps/podium-desktop/src-tauri && cargo clippy --all-targets -- -D warnings

typecheck: install
	npm run typecheck

test: install
	npm run test
	$(PYTHON) -m pytest apps/performer/tests -q
	cd apps/podium-desktop/src-tauri && cargo test

test-all: lint typecheck build test

dev: install
	npm run dev -w @symphony/podium-desktop

stop:
	-pkill -f 'apps/conductor/dist/main.js'
	-pkill -f 'performer --turn-request-path'
