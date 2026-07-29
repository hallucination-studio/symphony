.PHONY: install build lint typecheck test test-all dev stop

install:
	npm install

build: install
	npm run build

lint: install
	npm run lint

typecheck: install
	npm run typecheck

test: install
	npm run test

test-all: lint typecheck build test

dev: install
	npm run dev -w @symphony/conductor

stop:
	-pkill -f 'apps/conductor/dist/main.js'
