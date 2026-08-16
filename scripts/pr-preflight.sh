#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case " ${NODE_OPTIONS:-} " in
  *" --conditions=remnic-source "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=remnic-source" ;;
esac

run() {
  echo "[preflight] $*"
  "$@"
}

run_quiet() {
  echo "[preflight] $*"
  "$@" >/dev/null
}

changed_files() {
  local base_ref="${PREFLIGHT_BASE_REF:-origin/main}"

  if git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
    git diff --name-only "$(git merge-base HEAD "$base_ref")"...HEAD
    return
  fi

  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff --name-only HEAD~1...HEAD
  fi
}

needs_entity_hardening() {
  local files
  files="$(changed_files)"
  if [[ -z "$files" ]]; then
    return 1
  fi

  local risky_path_pattern
  risky_path_pattern='^(src|packages/remnic-core/src)/'
  risky_path_pattern+='((orchestrator|storage|intent|memory-cache|entity-retrieval|config)\.ts$|(storage|orchestration)/)'
  if printf '%s\n' "$files" | grep -Eq "$risky_path_pattern"; then
    return 0
  fi

  return 1
}

if [[ "$MODE" == "--check-entity-hardening-path" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "usage: $0 --check-entity-hardening-path <path>" >&2
    exit 2
  fi
  ENTITY_HARDENING_PATH="$2"
  changed_files() {
    printf '%s\n' "$ENTITY_HARDENING_PATH"
  }
  needs_entity_hardening
  exit
fi

changeset_code_file() {
  local file="$1"
  case "$file" in
    src/*) return 0 ;;
    packages/*/*)
      local package_name="${file#packages/}"
      package_name="${package_name%%/*}"
      local manifest="packages/${package_name}/package.json"
      [[ -f "$manifest" ]] || return 1
      node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(pkg.private === true ? 1 : 0)' "$manifest"
      ;;
    *) return 1 ;;
  esac
}

changeset_warning_needed() {
  local files="$1"
  local has_code=0
  local has_changeset=0
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    case "$file" in
      .changeset/*.md) has_changeset=1 ;;
      .changeset/*|README.md|CHANGELOG.md|CONTRIBUTING.md|AGENTS.md|*/README.md|*/AGENTS.md|*/CONTRIBUTING.md|*/CHANGELOG.md|docs/*) ;;
      package.json|pnpm-lock.yaml|openclaw.plugin.json|packages/*/package.json|packages/*/openclaw.plugin.json|packages/*/.claude-plugin/plugin.json|packages/*/.codex-plugin/plugin.json) ;;
      *) changeset_code_file "$file" && has_code=1 ;;
    esac
  done <<< "$files"
  [[ "$has_code" -eq 1 && "$has_changeset" -eq 0 ]]
}

if [[ "$MODE" == "--check-changeset" ]]; then
  if [[ "$#" -lt 2 ]]; then
    echo "usage: $0 --check-changeset <changed-path>..." >&2
    exit 2
  fi
  changed_paths="$(printf '%s\n' "${@:2}")"
  if changeset_warning_needed "$changed_paths"; then
    echo "[preflight] WARNING: code changes detected without a changeset. Run: node scripts/changeset-stub.mjs"
  fi
  exit 0
fi
run node tests/pr-preflight-paths.test.mjs

# Core mandatory gate from docs/ops/pr-review-hardening-playbook.md
run npm run lint
run npm run check-types
run npm run check-config-contract
run npm run plugin:inspect
run bash scripts/check-review-patterns.sh
run node scripts/check-ratchets.mjs
run node scripts/check-docs-parity.mjs
run node scripts/check-dataset-hygiene.mjs
run pnpm exec turbo --version
run_quiet pnpm exec turbo run check-types --dry=json

if needs_entity_hardening; then
  run npm run test:entity-hardening
fi

if [[ "$MODE" == "quick" ]]; then
  # Registration contract tests catch silent lifecycle breakage (issues #282, #285).
  # Run first — registration regressions are caught before slower tests.
  run pnpm exec tsx --test tests/openclaw-registration-capture.test.ts
  run npm run check:openclaw-sdk-surface
  run pnpm exec tsx --test tests/openclaw-sdk-surface-check.test.ts
  run npm run test:openclaw-scenarios
  run npm run test:openclaw-privacy
  run pnpm exec tsx --test tests/register-multi-registry.test.ts
  run pnpm exec tsx --test tests/intent.test.ts
  run pnpm exec tsx --test tests/runtime-input-guards.test.ts
  run pnpm exec tsx --test tests/build-staleness.test.mjs
  run pnpm exec tsx --test tests/artifact-recall-limit.test.ts
  run pnpm exec tsx --test tests/artifact-status-snapshot.test.ts
  run pnpm exec tsx --test tests/recall-no-recall-short-circuit.test.ts
  run pnpm exec tsx --test tests/orchestrator-path-filter.test.ts
  run pnpm exec tsx --test tests/artifact-cache.test.ts
  # Access boundary fitness test — enforces catalog completeness and the
  # unmigrated-handler ratchet on every quick preflight (issue #1525).
  run pnpm exec tsx --test packages/remnic-core/src/access-surface-catalog.test.ts
  # CLI command-surface contract tests — pin every subcommand dispatches +
  # validation rejects bad input (issue #1532 Phase A). Guards the cli.ts
  # decomposition: a dropped/renamed command fails here before review.
  run pnpm exec tsx --test packages/remnic-cli/src/cli-command-surface.test.ts
else
  run npm test
  run npm run build
fi


# Changeset reminder: this is advisory because docs-only and release-only
# changes do not need package release metadata.
if changeset_warning_needed "$(changed_files)"; then
  echo "[preflight] WARNING: code changes detected without a changeset. Run: node scripts/changeset-stub.mjs"
fi

echo "[preflight] OK ($MODE)"
