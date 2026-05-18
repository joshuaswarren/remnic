.PHONY: build test lint preflight preflight-quick clean help

# Default target
help:
	@echo "remnic — available make targets:"
	@echo ""
	@echo "  make build           Compile TypeScript to dist/"
	@echo "  make test            Run full test suite"
	@echo "  make lint            TypeScript type check (tsc --noEmit)"
	@echo "  make preflight       Full pre-PR gate (types + contract + tests + build)"
	@echo "  make preflight-quick Fast pre-PR gate (types + contract + key tests)"
	@echo "  make clean           Remove dist/ and build artifacts"
	@echo ""

build:
	npm run build

test:
	npm test

lint:
	npm run check-types

preflight:
	npm run preflight

preflight-quick:
	npm run preflight:quick

clean:
	rm -rf dist/
