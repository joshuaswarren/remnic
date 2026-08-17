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
all_package_dirs() {
  node -e '
    const { existsSync, readdirSync } = require("node:fs");
    for (const name of readdirSync("packages").sort()) {
      if (existsSync(`packages/${name}/package.json`)) console.log(name);
    }
  '
}

package_dependents() {
  QUICK_SCOPE_SEEDS="$1" node -e '
    const { existsSync, readFileSync, readdirSync } = require("node:fs");
    const packages = new Map();
    const namesByPackage = new Map();
    for (const directory of readdirSync("packages").sort()) {
      const packagePath = `packages/${directory}/package.json`;
      if (!existsSync(packagePath)) continue;
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      packages.set(directory, packageJson);
      namesByPackage.set(packageJson.name, directory);
    }

    const selected = new Set((process.env.QUICK_SCOPE_SEEDS ?? "").split("\n").filter(Boolean));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [directory, packageJson] of packages) {
        const peerDependencies = Object.fromEntries(
          Object.entries(packageJson.peerDependencies ?? {}).filter(
            ([name]) => packageJson.peerDependenciesMeta?.[name]?.optional !== true,
          ),
        );
        const dependencies = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
          ...packageJson.optionalDependencies,
          ...peerDependencies,
        };
        if (
          Object.keys(dependencies ?? {}).some((name) => {
            const dependencyDirectory = namesByPackage.get(name);
            return dependencyDirectory !== undefined && selected.has(dependencyDirectory);
          }) &&
          !selected.has(directory)
        ) {
          selected.add(directory);
          expanded = true;
        }
      }
    }
    for (const directory of [...selected].sort()) console.log(directory);
  '
}

quick_package_scope() {
  local files
  local scope_all=0
  local package_name
  local package_dir
  local scope_seeds
  local expanded_scope
  local -a all_packages=()
  local -a checked_packages=()
  local -a skipped_packages=()

  mapfile -t all_packages < <(all_package_dirs)
  if ! files="$(quick_changed_files)"; then
    scope_all=1
  elif [[ -z "$files" ]]; then
    scope_all=1
  elif printf '%s\n' "$files" | grep -Eq '^(tsconfig[^/]*|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
    scope_all=1
  else
    while IFS= read -r package_name; do
      [[ -n "$package_name" ]] || continue
      package_dir="packages/$package_name"
      if [[ -d "$package_dir" ]]; then
        checked_packages+=("$package_name")
      fi
    done < <(printf '%s\n' "$files" | sed -n 's#^packages/\([^/]*\)\(/.*\)\?$#\1#p' | sort -u)

    if ((${#checked_packages[@]} > 0)); then
      scope_seeds="$(printf '%s\n' "${checked_packages[@]}")"
      expanded_scope="$(package_dependents "$scope_seeds")"
      mapfile -t checked_packages <<< "$expanded_scope"
    fi
  fi

  if ((scope_all)); then
    checked_packages=("${all_packages[@]}")
  fi

  for package_name in "${all_packages[@]}"; do
    if printf '%s\n' "${checked_packages[@]}" | grep -Fxq "$package_name"; then
      continue
    fi
    skipped_packages+=("$package_name")
  done

  QUICK_SCOPE_ALL="$scope_all"
  QUICK_SCOPE_CHECKED=("${checked_packages[@]}")
  QUICK_SCOPE_SKIPPED=("${skipped_packages[@]}")
}

quick_changed_files() {
  local base_ref="${PREFLIGHT_BASE_REF:-origin/main}"
  local merge_base

  if [[ ${PREFLIGHT_CHANGED_FILES+x} ]]; then
    printf '%s\n' "${PREFLIGHT_CHANGED_FILES}"
    return 0
  fi

  if git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
    merge_base="$(git merge-base HEAD "$base_ref")" || return 1
    git diff --name-only "$merge_base"...HEAD || return 1
    git diff --name-only || return 1
    git diff --name-only --cached || return 1
    return 0
  fi

  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff --name-only HEAD~1...HEAD || return 1
    git diff --name-only || return 1
    git diff --name-only --cached || return 1
    return 0
  fi

  return 1
}

print_quick_package_scope() {
  quick_package_scope
  if ((QUICK_SCOPE_ALL)); then
    echo "[preflight] Quick package scope: all packages"
  else
    echo "[preflight] Quick package scope: affected packages"
  fi
  echo "[preflight] Quick mode skips untouched package checks; use full preflight for workspace-wide errors."
  printf '[preflight] Checked packages:'
  printf ' %s' "${QUICK_SCOPE_CHECKED[@]}"
  printf '\n'
  printf '[preflight] Skipped packages:'
  printf ' %s' "${QUICK_SCOPE_SKIPPED[@]}"
  printf '\n'
}

run_quick_type_checks() {
  quick_package_scope
  print_quick_package_scope

  if ((QUICK_SCOPE_ALL)); then
    run npm run check-types
    return
  fi

  # Root type-checking and the core build remain prerequisites for package checks.
  run pnpm --filter @remnic/core build
  run pnpm exec tsc --noEmit
  if ((${#QUICK_SCOPE_CHECKED[@]} > 0)); then
    local -a package_filters=()
    local package_name
    for package_name in "${QUICK_SCOPE_CHECKED[@]}"; do
      package_filters+=(--filter "./packages/$package_name")
    done
    run pnpm --recursive --if-present "${package_filters[@]}" run check-types
  else
    echo "[preflight] No affected packages; skipped recursive package check-types"
  fi
  run node scripts/check-test-types.mjs
}

QUICK_SCOPE_ALL=0
QUICK_SCOPE_CHECKED=()
QUICK_SCOPE_SKIPPED=()

if [[ "$MODE" == "--print-quick-package-scope" ]]; then
  print_quick_package_scope
  exit
fi

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
if [[ "$MODE" == "quick" ]]; then
  run_quick_type_checks
else
  run npm run check-types
fi
run npm run check-config-contract
run npm run plugin:inspect
run bash scripts/check-review-patterns.sh
run node scripts/check-ratchets.mjs
run node scripts/check-package-test-files.mjs

run node scripts/check-docs-parity.mjs
run node scripts/check-dataset-hygiene.mjs
run npm run check:regex-safety
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
