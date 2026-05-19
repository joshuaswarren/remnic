.PHONY: build test lint preflight preflight-quick clean help

# Default target
help:
	@echo "remnic — available make targets:"
	@echo ""
	@echo "  make build           Compile TypeScript to dist/"
	@echo "  make test            Run full test suite"
	@echo "  make lint            TypeScript type check (root + workspace packages)"
	@echo "  make preflight       Full pre-PR gate (types + contract + tests + build)"
	@echo "  make preflight-quick Fast pre-PR gate (types + contract + key tests)"
	@echo "  make clean           Remove dist/ and build artifacts"
	@echo ""

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm check-types

preflight:
	pnpm preflight

preflight-quick:
	pnpm preflight:quick

clean:
	rm -rf dist/
