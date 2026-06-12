# ──────────────────────────────────────────────────────────────────────────────
# Neuralgentics Makefile — Quality Gates
# Mirrors boomerang-v3's lint → typecheck → build → test → smoke discipline,
# adapted for Go modules + TypeScript overlay.
# ──────────────────────────────────────────────────────────────────────────────

.PHONY: all lint lint-shell typecheck build test smoke clean help docs-serve docs-build

# Go modules (must match go.work)
GO_MODULES := packages/memory packages/orchestrator-go packages/broker-go packages/backend-go

# TypeScript overlay package
OVERLAY := overlay/packages/opencode

# Backend binary output
BINARY := packages/backend-go/neuralgentics-backend

# ──────────────────────────────────────────────────────────────────────────────
# Top-level: run every gate, fail fast on first error
# ──────────────────────────────────────────────────────────────────────────────
all: lint lint-shell typecheck build test smoke
	@echo ""
	@echo "✓ All quality gates passed"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 1 — Lint: go vet on every Go module
# ──────────────────────────────────────────────────────────────────────────────
lint:
	@for m in $(GO_MODULES); do \
		echo "=== $$m (go vet) ==="; \
		(cd $$m && go vet ./...) || exit 1; \
	done
	@echo "✓ Lint passed (4 Go modules)"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 1b — Lint: shell scripts (bash -n syntax check)
# ──────────────────────────────────────────────────────────────────────────────
lint-shell:
	@echo "=== scripts/*.sh (bash -n) ==="
	@for f in scripts/*.sh; do \
		echo "  $$f"; \
		bash -n "$$f" || exit 1; \
	done
	@echo "✓ Shell lint passed"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 2 — Typecheck: tsc --noEmit on the overlay
# ──────────────────────────────────────────────────────────────────────────────
typecheck:
	@echo "=== $(OVERLAY) (tsc --noEmit) ==="
	cd $(OVERLAY) && npm run typecheck
	@echo "✓ Typecheck passed"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 3 — Build: go build + overlay tsc
# ──────────────────────────────────────────────────────────────────────────────
build:
	@for m in $(GO_MODULES); do \
		echo "=== $$m (go build) ==="; \
		(cd $$m && go build ./...) || exit 1; \
	done
	@echo "=== $(OVERLAY) (npm run build) ==="
	cd $(OVERLAY) && npm run build
	@echo "✓ Build passed"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 4 — Test: go test -short on every module + overlay (if test script exists)
# ──────────────────────────────────────────────────────────────────────────────
test:
	@for m in $(GO_MODULES); do \
		echo "=== $$m (go test -short) ==="; \
		(cd $$m && go test -short ./...) || exit 1; \
	done
	@echo "=== $(OVERLAY) (npm test) ==="
	cd $(OVERLAY) && npm test --if-present
	@echo "✓ Tests passed (4 Go modules + overlay)"

# ──────────────────────────────────────────────────────────────────────────────
# Gate 5 — Smoke: JSON-RPC integration smoke test (requires test DB on :6000)
# ──────────────────────────────────────────────────────────────────────────────
smoke:
	@echo "=== smoke test ==="
	./tests/smoke-test-mvp.sh
	@echo "✓ Smoke test passed"

# ──────────────────────────────────────────────────────────────────────────────
# Clean: remove build artifacts
# ──────────────────────────────────────────────────────────────────────────────
clean:
	@for m in $(GO_MODULES); do \
		echo "=== $$m (go clean) ==="; \
		(cd $$m && go clean) || true; \
	done
	rm -f $(BINARY)
	rm -rf $(OVERLAY)/dist
	@echo "✓ Cleaned"

# ──────────────────────────────────────────────────────────────────────────────
# Docs: MkDocs site generation and serving
# ──────────────────────────────────────────────────────────────────────────────
docs-serve:
	@echo "=== Serving Neuralgentics Docs ==="
	pip install -r docs/requirements.txt
	mkdocs serve

docs-build:
	@echo "=== Building Neuralgentics Docs ==="
	pip install -r docs/requirements.txt
	mkdocs build --strict
	@echo "✓ Docs built in site/"

# ──────────────────────────────────────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────────────────────────────────────
help:
	@echo "Neuralgentics — Quality Gates"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  all        Run all quality gates (lint + typecheck + build + test + smoke)"
	@echo "  lint         Run go vet on all 4 Go modules"
	@echo "  lint-shell   Run bash -n on all scripts/*.sh"
	@echo "  typecheck    Run tsc --noEmit on the overlay"
	@echo "  build      Build all 4 Go modules + overlay TS"
	@echo "  test       Run all tests (4 Go modules + overlay)"
	@echo "  smoke      Run the JSON-RPC smoke test (requires test DB on :6000)"
	@echo "  clean      Remove build artifacts"
	@echo "  docs-serve  Serve documentation site locally"
	@echo "  docs-build  Build documentation site (strict)"
	@echo "  help       Show this message"
	@echo ""
	@echo "Default target: help"

.DEFAULT_GOAL := help