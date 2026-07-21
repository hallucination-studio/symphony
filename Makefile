VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(PYTHON) -m pip
E2E_SECRET_FREE := env -u SYMPHONY_E2E_LINEAR_DEV_TOKEN -u SYMPHONY_E2E_CODEX_API_KEY
E2E_LIVE := node --env-file-if-exists=.env tools/e2e/core-live-entry.mjs

.PHONY: install build lint typecheck test test-all e2e dev stop

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

e2e:
	$(E2E_SECRET_FREE) $(MAKE) install
	$(E2E_SECRET_FREE) npm run build -w @symphony/podium
	$(E2E_SECRET_FREE) npm run build -w @symphony/conductor
	$(E2E_SECRET_FREE) npm run test:e2e:runner
	$(E2E_LIVE)

dev: install
	npm run dev -w @symphony/podium-desktop

stop:
	-pkill -f 'apps/conductor/dist/main.js'
