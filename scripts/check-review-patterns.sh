#!/usr/bin/env bash
# check-review-patterns.sh — Catch common issues that reviewers (Cursor Bugbot,
# Codex, CodeQL) repeatedly flagged across PRs #343-#408 (700+ review comments).
# Run this before pushing. Zero exit = clean.
# Updated: 2026-04-12 (added checks 7-10 from iteration 2, 11-14 from iteration 3, 15-17 from iteration 4, 18-21 from iteration 5, 22-23 from iteration 7, 24-26 from iteration 8, 27-29 from iteration 10, 30-34 from iteration 12).
# 2026-07-07: graduated rules 17 (→check #7), 18 (→check #9), 32 (→check #16), 35 (→check #18), 38 (→check #20), 41 (→check #23), 45 (→check #25), 50 (→check #29), 51 (→#1525 boundary + check #30), 52 (→check #31). CLAUDE.md 45→35 rules.
# 2026-07-07: graduated rules 39 (→capabilities.test.ts), 42 (→scope-plan.test.ts), 47 (→check #27), 48 (→check #28), 54 (→check #33), 55 (→check-docs-parity.mjs + check #34). CLAUDE.md 51→45 rules.
# 2026-07-08: batch 6 (final) — graduated rules 9 (→check #40 NEW), 14 (→#1525 boundary registry + check #30), 24 (→check #38 NEW), 57 (→check #39 NEW, BLOCKING). CLAUDE.md 22→18 rules (target <20 met).
# 2026-07-06: added check 37 (rule 53 ad-hoc status exclusion, WARN). Graduated rules 36 (→check #19), 46 (→check #26), 53 (→check #37).
# 2026-07-05: check 15 graduated to BLOCKING + added codex-* prefix + maxdepth-1 scope (rule 31, PR #TBD).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ERRORS=0

warn() { echo "  WARN: $*"; }
fail() { echo "  FAIL: $*"; ERRORS=$((ERRORS + 1)); }

# ---- 1. Stale "engram" references in code (not in allowed legacy-fallback locations) ----
echo "[check] Stale 'engram' references outside legacy fallback paths..."

# Allow legitimate legacy references: migration code, legacy fallback chains,
# historical docs, changelog, and the rename plan doc.
STALE=$(grep -ri "engram" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" \
  --include="*.json" --include="*.md" --include="*.sh" --include="*.py" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  --exclude="CHANGELOG.md" --exclude="RENAME.md" --exclude="package-lock.json" \
  --exclude="pnpm-lock.yaml" \
  -l . 2>/dev/null \
  | grep -v "from-engram" \
  | grep -v "migration" \
  | grep -v "migrate" \
  | grep -v "legacy" \
  | grep -v "shim-openclaw-engram" \
  | grep -v "CLAUDE.md" \
  | grep -v "AGENTS.md" \
  | grep -v "engram-adapter" \
  | grep -v "check-review-patterns.sh" \
  || true)

if [[ -n "$STALE" ]]; then
  # Check if the remaining references have legacy fallback context
  while IFS= read -r file; do
    # Count references - if more than a few, flag
    COUNT=$(grep -ci "engram" "$file" 2>/dev/null || true)
    if [[ "$COUNT" -gt 3 ]]; then
      warn "$file has $COUNT 'engram' references — verify these are intentional legacy fallbacks, not stale names"
    fi
  done <<< "$STALE"
else
  echo "  OK: No suspicious stale 'engram' references"
fi

# ---- 2. Shell command interpolation (security) ----
echo "[check] String interpolation in shell command construction..."

SHELL_INJECT=$(grep -rn '\${' \
  --include="*.ts" --include="*.js" \
  packages/remnic-core/src/connectors/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -i -E "(exec|spawn|shell|command|script)" \
  | grep -v "process.env" \
  | grep -v "EnvironmentVariables" \
  | grep -v "// " \
  | grep -v "import.meta" \
  || true)

if [[ -n "$SHELL_INJECT" ]]; then
  warn "Potential shell interpolation in command construction:"
  echo "$SHELL_INJECT" | head -5 || true
  echo "  → Use env vars instead of string interpolation for host/port/config values"
fi

# ---- 3. Duplicate helper detection ----
echo "[check] Duplicated utility functions across packages..."

for helper in "toolJsonResult" "parseConfig" "formatMemory"; do
  FILES=$(grep -rn "$helper" --include="*.ts" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude-dir=.claude --exclude-dir=.worktrees \
    -l . 2>/dev/null \
    | grep -v node_modules \
    | grep -v ".test." \
    | grep -v dist \
    || true)
  COUNT=$(echo "$FILES" | grep -c "." 2>/dev/null || echo "0")
  COUNT=$(echo "$COUNT" | tr -d '[:space:]')
  if [[ "$COUNT" -gt 2 ]]; then
    warn "$helper defined in $COUNT files — consider extracting to shared utility:"
    echo "$FILES"
  fi
done

# ---- 4. Test quality: vacuous empty-array assertions ----
echo "[check] Vacuous empty-array test assertions..."

VACUOUS=$(grep -rn "toEqual(\[\])" --include="*.test.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v "// intentional" \
  || true)

if [[ -n "$VACUOUS" ]]; then
  COUNT=$(echo "$VACUOUS" | wc -l | tr -d ' ')
  warn "$COUNT tests assert .toEqual([]) — ensure these verify actual failure behavior, not vacuous passes:"
  echo "$VACUOUS" | head -5 || true
fi

# ---- 5. Lock file sync check ----
echo "[check] Workspace dependency consistency..."

if [[ -f package-lock.json ]]; then
  fail "package-lock.json is not supported in this pnpm workspace — remove it and keep pnpm-lock.yaml as the lockfile"
fi

if command -v pnpm &>/dev/null; then
  # Check if pnpm-lock.yaml is stale
  # Simple check: does running install change anything?
  PNPM_OUTPUT=""
  if PNPM_OUTPUT=$(pnpm install --frozen-lockfile 2>&1); then
    echo "  OK: Lock file is in sync"
  else
    PNPM_STATUS=$?
    if echo "$PNPM_OUTPUT" | grep -qE "ERR_PNPM_FROZEN_LOCKFILE|ERR_PNPM_OUTDATED_LOCKFILE"; then
      fail "pnpm-lock.yaml is out of sync — run 'pnpm install' and commit the updated lockfile"
    else
      fail "pnpm lockfile verification failed with exit ${PNPM_STATUS} — inspect 'pnpm install --frozen-lockfile' output"
      printf '%s\n' "$PNPM_OUTPUT" | sed 's/^/    /' | head -20 || true
    fi
  fi
fi

# ---- 6. Missing resetGlobals cleanup in test files ----
echo "[check] Test teardown completeness..."

# Check if any test file creates orchestrator instances but doesn't call resetGlobals
ORCH_TEST=$(grep -rl "Orchestrator\|orchestrator" --include="*.test.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  || true)

if [[ -n "$ORCH_TEST" ]]; then
  while IFS= read -r file; do
    if ! grep -q "resetGlobals\|afterEach\|afterAll\|tearDown" "$file" 2>/dev/null; then
      warn "$file uses Orchestrator but has no resetGlobals/afterEach cleanup"
    fi
  done <<< "$ORCH_TEST"
fi

# ---- 7. Tilde path without expandTilde ----
echo "[check] Tilde path expansion consistency..."

# Look for .replace(/^~/ or similar ad-hoc tilde expansion that isn't expandTilde
TILDE_HACK=$(grep -rn '\.replace(/\^~/' \
  --include="*.ts" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v expandTilde \
  || true)

if [[ -n "$TILDE_HACK" ]]; then
  COUNT=$(echo "$TILDE_HACK" | wc -l | tr -d ' ')
  warn "$COUNT ad-hoc tilde expansions (not using expandTilde) — use expandTilde() instead:"
  echo "$TILDE_HACK" | head -5 || true
fi

# ---- 8. Sort comparator never returns 0 ----
echo "[check] Sort comparator stability..."

# Look for comparators that return 1 for both directions (missing return 0)
BAD_SORT=$(grep -rn 'return 1' --include="*.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -i "sort" \
  || true)

if [[ -n "$BAD_SORT" ]]; then
  # Check if the file containing sort+return 1 ever returns 0 or -1
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    if ! grep -q "return 0\|return -1" "$FILE" 2>/dev/null; then
      warn "$FILE has sort logic with 'return 1' but no 'return 0' or 'return -1' — likely violates comparator contract"
    fi
  done <<< "$BAD_SORT"
fi

# ---- 9. JSON.parse without type validation ----
echo "[check] JSON.parse result validation..."

# Look for JSON.parse without subsequent type check
PARSE_NO_CHECK=$(grep -rn 'JSON.parse(' \
  --include="*.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$PARSE_NO_CHECK" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if next few lines have typeof/null check
    if ! sed -n "$((LINENUM)),$((LINENUM+5))p" "$FILE" 2>/dev/null | grep -q "typeof\|!== null\|=== null\|!== undefined\|isPlainObject\|isValid"; then
      # Only warn for config/settings files
      if echo "$FILE" | grep -qi "config\|setting\|install\|doctor"; then
        warn "$FILE:$LINENUM — JSON.parse without subsequent type/null validation in config path"
      fi
    fi
  done <<< "$PARSE_NO_CHECK"
fi

# ---- 10. Duplicated slot resolution logic ----
echo "[check] Config resolution deduplication..."

SLOT_RESOLVE=$(grep -rn "slots.*memory\|slots\.memory\|LEGACY_PLUGIN_ID\|resolveRemnicPluginEntry" \
  --include="*.ts" --include="*.cjs" --include="*.mjs" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "import.*from\|export" \
  || true)

RESOLVE_FILES=$(echo "$SLOT_RESOLVE" | cut -d: -f1 | sort -u 2>/dev/null || true)
RESOLVE_COUNT=$(echo "$RESOLVE_FILES" | grep -c "." 2>/dev/null || echo "0")

if [[ "$RESOLVE_COUNT" -gt 3 ]]; then
  warn "Slot resolution logic found in $RESOLVE_COUNT files — should be deduplicated to single shared module:"
  echo "$RESOLVE_FILES"
fi

# ---- 11. Cross-package relative imports (breaks package boundaries) ----
echo "[check] Cross-package relative imports..."

CROSS_PKG=$(grep -rn 'from "\.\./\.\./\.\./\.\./' \
  --include="*.ts" --include="*.js" --include="*.mjs" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  || true)

if [[ -n "$CROSS_PKG" ]]; then
  COUNT=$(echo "$CROSS_PKG" | wc -l | tr -d ' ')
  warn "$COUNT deep relative imports (4+ levels) in packages/ — likely bypassing package boundaries. Use package name imports instead:"
  echo "$CROSS_PKG" | head -10 || true
fi

# ---- 12. slice(-expr) without zero guard ----
echo "[check] slice(-expr) without zero/negative guard..."

SLICE_NEG=$(grep -rn 'slice(-' \
  --include="*.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$SLICE_NEG" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if surrounding context has a <= 0 or < 1 guard
    if ! sed -n "$((LINENUM > 3 ? LINENUM-3 : 1)),$((LINENUM+1))p" "$FILE" 2>/dev/null | grep -q "<= 0\|< 1\|=== 0\|!== 0\| > 0"; then
      warn "$FILE:$LINENUM — slice(-expr) without nearby zero guard. When expr is 0, slice(-0) returns ALL items."
    fi
  done <<< "$SLICE_NEG"
fi

# ---- 13. typeof === "number" on config values that may be strings ----
echo "[check] Fragile typeof === 'number' on persisted config values..."

TYPEOF_NUM=$(grep -rn 'typeof.*===.*"number"' \
  --include="*.ts" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "isInteger\|Number(" \
  | grep -i "port\|config\|prev\|saved\|stored\|options\." \
  || true)

if [[ -n "$TYPEOF_NUM" ]]; then
  COUNT=$(echo "$TYPEOF_NUM" | wc -l | tr -d ' ')
  warn "$COUNT typeof === 'number' checks on config/port/prev values — CLI values arrive as strings. Consider coercing first:"
  echo "$TYPEOF_NUM" | head -5 || true
fi

# ---- 14. Force flush / explicit operations missing skipDedupe ----
echo "[check] Explicit flush paths missing skipDedupeCheck..."

FLUSH_NO_SKIP=$(grep -rn 'flushSession\|forceFlush\|queueBufferedExtraction' \
  --include="*.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$FLUSH_NO_SKIP" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if this call or its function passes skipDedupeCheck
    if ! sed -n "$((LINENUM)),$((LINENUM+3))p" "$FILE" 2>/dev/null | grep -q "skipDedupeCheck\|skipDedupe"; then
      # Only warn for flush paths that look explicit (not auto-extraction)
      if echo "$line" | grep -qi "flush\|force\|reset\|replay"; then
        warn "$FILE:$LINENUM — flush/force/replay call without skipDedupeCheck. Explicit operations should bypass dedup."
      fi
    fi
  done <<< "$FLUSH_NO_SKIP"
fi

# ---- 15. Host-prefixed files in core package (architecture boundary, CLAUDE.md rule 31) ----
echo "[check] Host-prefixed files in @remnic/core (BLOCKING)..."

# Rule 31: generic modules in @remnic/core must use generic names; host
# adapters wrap core, not the other way around. Legitimate host adapters
# (publishers, connectors) live in subdirectories (memory-extension/,
# connectors/, adapters/) and are excluded by -maxdepth 1, which scopes the
# check to top-level generic modules where a host prefix is always a violation.
HOST_PREFIXED=$(find packages/remnic-core/src -maxdepth 1 -type f \
  \( -name "openclaw-*" -o -name "hermes-*" -o -name "codex-*" \) \
  2>/dev/null || true)

if [[ -n "$HOST_PREFIXED" ]]; then
  while IFS= read -r file; do
    fail "$file — host-prefixed file in @remnic/core violates rule 31 (architecture boundary). Rename to a generic name; host adapters belong in subdirectories."
  done <<< "$HOST_PREFIXED"
fi

# ---- 16. indexOf in line parsers (position tracking) ----
echo "[check] indexOf usage in parser/position-tracking code..."

INDEXOF_PARSER=$(grep -rn '\.indexOf(' \
  --include="*.ts" \
  packages/remnic-core/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -i "offset\|position\|source\|line\|parse\|block" \
  || true)

if [[ -n "$INDEXOF_PARSER" ]]; then
  COUNT=$(echo "$INDEXOF_PARSER" | wc -l | tr -d ' ')
  if [[ "$COUNT" -gt 0 ]]; then
    warn "$COUNT uses of indexOf in parser/position-tracking code — may return wrong position for duplicate lines. Track offset during iteration instead."
    echo "$INDEXOF_PARSER" | head -5 || true
  fi
fi

# ---- 17. Test mocks with fewer parameters than production interface ----
echo "[check] Test mock signature fidelity..."

# Look for mock function definitions that might ignore parameters.
# Pattern: jest.fn(() => ...) or vi.fn(() => ...) where the function
# ignores its arguments in test files near interface implementations.
MOCK_NO_ARGS=$(grep -rn 'fn(()\s*=>\s*{' \
  --include="*.test.ts" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v "_\s*:" \
  || true)

if [[ -n "$MOCK_NO_ARGS" ]]; then
  # Only warn if the production interface nearby takes arguments
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Check if the same file references a runtime interface that takes arguments
    if grep -q "getLastRecall\|getSession\|getBuffer\|getRecall" "$FILE" 2>/dev/null; then
      # Check if any mock in the file accepts parameters
      if ! grep -q 'fn((.*:.*)\s*=>' "$FILE" 2>/dev/null; then
        warn "$FILE — contains zero-argument mocks for functions that take parameters in production. Verify mock signatures match."
        break
      fi
    fi
  done <<< "$MOCK_NO_ARGS"
fi

# ---- 18. Time-range filters with inclusive upper bounds ----
echo "[check] Time-range filters using inclusive upper bounds (<=)..."

INCLUSIVE_TIME=$(grep -rn '<= .*[Tt]ime\|<= .*[Tt]s\|<= .*[Mm]s\|<= .*[Dd]ate\|<= .*now\|<= .*stamp' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -i "filter\|window\|range\|between\|briefing\|recall" \
  || true)

if [[ -n "$INCLUSIVE_TIME" ]]; then
  COUNT=$(echo "$INCLUSIVE_TIME" | wc -l | tr -d ' ')
  warn "$COUNT time-range filters using <= on timestamp values in filter/window/range code. Verify these use exclusive upper bound (<) for half-open intervals:"
  echo "$INCLUSIVE_TIME" | head -5 || true
fi

# ---- 19. String "false" used as boolean gate ----
echo "[check] Boolean config gates using !== false..."

STRICT_BOOL_GATE=$(grep -rn '!== false\|!= false' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -i "config\|option\|setting\|flag\|enabled\|install" \
  || true)

if [[ -n "$STRICT_BOOL_GATE" ]]; then
  COUNT=$(echo "$STRICT_BOOL_GATE" | wc -l | tr -d ' ')
  warn "$COUNT boolean gates using !== false on config/option values. String 'false' is truthy with this check. Use explicit boolean coercion:"
  echo "$STRICT_BOOL_GATE" | head -5 || true
fi

# ---- 20. Object.entries in hash/dedup without key sorting ----
echo "[check] Object.entries in hash/dedup without key sorting..."

UNSORTED_ENTRIES=$(grep -rn 'Object.entries(' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -i "hash\|dedup\|serial\|finger\|content.*hash\|hash.*content\|digest" \
  || true)

if [[ -n "$UNSORTED_ENTRIES" ]]; then
  COUNT=$(echo "$UNSORTED_ENTRIES" | wc -l | tr -d ' ')
  warn "$COUNT Object.entries() calls in hash/dedup/serialization code without visible key sorting. Insertion order is non-deterministic — sort keys first:"
  echo "$UNSORTED_ENTRIES" | head -5 || true
fi

# ---- 21. invalidateAll* that doesn't clear all cache layers ----
echo "[check] Cache invalidation naming accuracy..."

CACHE_INVALIDATE=$(grep -rnE 'invalidateAll|clearAll|resetAll|flushAll' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$CACHE_INVALIDATE" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Check if the file also has other cache variables not mentioned in the invalidation function
    OTHER_CACHES=$(grep -cE 'Cache|cache' "$FILE" 2>/dev/null || true)
    OTHER_CACHES=${OTHER_CACHES:-0}
    INVALIDATE_LINES=$(grep -cE 'invalidateAll|clearAll|resetAll' "$FILE" 2>/dev/null || true)
    INVALIDATE_LINES=${INVALIDATE_LINES:-0}
    if [[ "$OTHER_CACHES" -gt 5 ]] && [[ "$INVALIDATE_LINES" -lt 2 ]]; then
      warn "$FILE — has $OTHER_CACHES cache references but only $INVALIDATE_LINES invalidateAll call(s). Verify all cache layers are cleared."
      break
    fi
  done <<< "$CACHE_INVALIDATE"
fi

# ---- 22. Self-referential serialized promise chains without rejection recovery ----
echo "[check] Self-referential serialized promise chains without rejection recovery..."

# A serialized chain is poisoned when a variable is reassigned to its OWN
# .then() with no rejection handler:  x = x.then(fn)   (no .catch, no 2nd
# onRejected arg). ERE has no backreferences, so we require the SAME identifier
# on both sides of '=' via awk; this avoids false positives on safe patterns
# like `const next = prev.then(fn, fn)` (different identifiers, 2-arg recovery).
# serialize-mutations (#1524) is the sanctioned chokepoint and is excluded.
POISON_CHAIN=$(grep -rn '\.then(' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -v "serialize-mutations" \
  | grep -v '\.catch(' \
  | awk '
      function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s; }
      {
        p1 = index($0, ":"); p2 = index(substr($0, p1+1), ":") + p1;
        c = substr($0, p2+1);
        if (match(c, /[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\.then[[:space:]]*\(/)) {
          seg = substr(c, RSTART, RLENGTH);
          eq = index(seg, "=");
          lhs = trim(substr(seg, 1, eq-1));
          rhs = trim(substr(seg, eq+1));
          sub(/\.then.*$/, "", rhs);
          rhs = trim(rhs);
          tail = substr(c, RSTART + RLENGTH);
          if (lhs == rhs && index(tail, ",") == 0) print $0;
        }
      }' \
  || true)

if [[ -n "$POISON_CHAIN" ]]; then
  COUNT=$(echo "$POISON_CHAIN" | wc -l | tr -d ' ')
  warn "$COUNT self-referential serialized promise chains (x = x.then(...)) without .catch() or 2-arg rejection recovery. A single rejection permanently breaks all subsequent chained operations:"
  echo "$POISON_CHAIN" | head -5 || true
fi

# ---- 23. Map/Set iteration using .values() but referencing key variables ----
echo "[check] Loop destructuring mismatch (values() with key references)..."

VALUES_KEY_MISMATCH=$(grep -rn 'for.*\.values()' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$VALUES_KEY_MISMATCH" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINE_NUM=$(echo "$line" | cut -d: -f2)
    # Check if the file has a variable named "key" or "id" referenced after this values() loop
    # that doesn't come from the loop destructuring
    CONTEXT=$(awk "NR>$LINE_NUM && NR<=$LINE_NUM+10" "$FILE" 2>/dev/null | grep -E '\bkey\b.*:|\bid\b.*:' || true)
    if [[ -n "$CONTEXT" ]]; then
      warn "$FILE:$LINE_NUM — .values() loop but key/id referenced in body. Use .entries() to destructure both key and value."
      break
    fi
  done <<< "$VALUES_KEY_MISMATCH"
fi

# ---- 24. Index add before persistence confirmed ----
echo "[check] Index/hash additions before persistence confirmation..."

INDEX_ADDS=$(grep -rnE 'factHashIndex\.add|contentHashIndex\.add|hashIndex\.add' \
  --include="*.ts" \
  packages/remnic-core/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$INDEX_ADDS" ]]; then
  COUNT=$(echo "$INDEX_ADDS" | wc -l | tr -d ' ')
  if [[ "$COUNT" -gt 3 ]]; then
    warn "$COUNT factHashIndex/contentHashIndex/hashIndex.add() calls in core — verify each is called AFTER successful persistence, not before:"
    echo "$INDEX_ADDS" | head -5 || true
  fi
fi

# ---- 25. Config schema minimum > 0 for documented disable-at-zero fields ----
echo "[check] Config schema minimums vs documented zero-disable..."

SCHEMA_MINIMUM_ONE=$(grep -rn '"minimum":\s*1' \
  --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.claude --exclude-dir=.worktrees \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep "plugin" \
  || true)

if [[ -n "$SCHEMA_MINIMUM_ONE" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Check if the same file mentions "set to 0 to disable" for this field
    if grep -q "0.*disable\|disable.*0\|set to 0" "$FILE" 2>/dev/null; then
      # Only warn for known fields that should accept 0
      if echo "$line" | grep -qi "candidate\|limit\|max\|min\|threshold\|count"; then
        warn "$line — schema minimum is 1. If docs say 'set to 0 to disable', change minimum to 0 and handle the 0 case in code."
      fi
    fi
  done <<< "$SCHEMA_MINIMUM_ONE"
fi

# ---- 26. Template-derived regex without escapeRegex ----
echo "[check] Template-derived regex without escaping..."

TEMPLATE_REGEX=$(grep -rn 'new RegExp(' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "escapeRegex\|escape(" \
  | grep -i "template\|prefix\|suffix\|pattern\|format\|config" \
  || true)

if [[ -n "$TEMPLATE_REGEX" ]]; then
  COUNT=$(echo "$TEMPLATE_REGEX" | wc -l | tr -d ' ')
  warn "$COUNT new RegExp() calls from template/config values without escapeRegex(). Literal parts must be escaped:"
  echo "$TEMPLATE_REGEX" | head -5 || true
fi

# ---- 27. Shared mutable state across connections (security) ----
echo "[check] Shared mutable objects accessible across connections..."

# Look for mutable objects that are set per-connection but stored on a shared instance
SHARED_MUTABLE=$(grep -rn 'this\.\(clientInfo\|sessionInfo\|connectionInfo\|adapterInfo\)\s*=' \
  --include="*.ts" \
  packages/ src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$SHARED_MUTABLE" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Check if the class has connection/session methods that might share state
    if grep -q "handleConnection\|onConnect\|newSession\|createSession\|handle" "$FILE" 2>/dev/null; then
      warn "$line — mutable state set in a class that handles multiple connections. Verify each connection gets its own instance."
      break
    fi
  done <<< "$SHARED_MUTABLE"
fi

# ---- 28. Enum defaults that silently approve/enable ----
echo "[check] Unsafe enum defaults (silently approving/enabling)..."

# Look for || "approved", || "enabled", || "active" fallback patterns
# Use fixed-string matching to avoid regex escaping confusion
UNSAFE_DEFAULTS=""
for keyword in "approved" "enabled" "active"; do
  MATCHES=$(grep -rn "|| \"${keyword}\"" \
    --include="*.ts" \
    packages/ src/ \
    2>/dev/null \
    | grep -v node_modules \
    | grep -v dist \
    | grep -v ".test." \
    | grep -v "// " \
    || true)
  if [[ -n "$MATCHES" ]]; then
    UNSAFE_DEFAULTS="${UNSAFE_DEFAULTS}${MATCHES}"$'\n'
  fi
  # Also check ?? "keyword" (nullish coalescing)
  MATCHES2=$(grep -rn "?? \"${keyword}\"" \
    --include="*.ts" \
    packages/ src/ \
    2>/dev/null \
    | grep -v node_modules \
    | grep -v dist \
    | grep -v ".test." \
    | grep -v "// " \
    || true)
  if [[ -n "$MATCHES2" ]]; then
    UNSAFE_DEFAULTS="${UNSAFE_DEFAULTS}${MATCHES2}"$'\n'
  fi
done

if [[ -n "$UNSAFE_DEFAULTS" ]]; then
  COUNT=$(echo "$UNSAFE_DEFAULTS" | wc -l | tr -d ' ')
  warn "$COUNT enum/default values that silently approve/enable. Missing values should default to least-privileged option (rejected/pending/disabled):"
  echo "$UNSAFE_DEFAULTS" | head -5 || true
fi

# ---- 29. CI quality gates silenced with || true ----
echo "[check] CI quality gates silenced with || true..."

if compgen -G ".github/workflows/*.yml" >/dev/null 2>&1 || compgen -G ".github/workflows/*.yaml" >/dev/null 2>&1; then
  SILENCED_GATES=$(grep -rn '|| true\|continue-on-error: true' \
    .github/workflows/ \
    2>/dev/null \
    | grep -i "test\|check\|lint\|type\|validate\|verify\|pytest\|mypy\|ruff\|tsc\|eslint" \
    || true)

  if [[ -n "$SILENCED_GATES" ]]; then
    COUNT=$(echo "$SILENCED_GATES" | wc -l | tr -d ' ')
    warn "$COUNT CI quality gate steps silenced with '|| true' or 'continue-on-error: true'. Test/lint/type steps must fail the build:"
    echo "$SILENCED_GATES" | head -5 || true
  fi
fi

# ---- 30. Silent fallback on invalid input (accept-then-default pattern) ----
echo "[check] Silent fallback patterns on invalid CLI/MCP input..."

# Look for patterns where invalid values silently default instead of throwing
SILENT_DEFAULT=$(grep -rnE '\|\| config\.|&& config\.|\|\| \.default|\?\? \.default|\|\|\s*\w+\.\w+Default' \
  --include="*.ts" \
  packages/remnic-cli/src/ packages/remnic-core/src/access-mcp.ts packages/remnic-core/src/access-service.ts \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -i "format\|since\|focus\|window\|briefing\|recall\|search" \
  || true)

if [[ -n "$SILENT_DEFAULT" ]]; then
  COUNT=$(echo "$SILENT_DEFAULT" | wc -l | tr -d ' ')
  warn "$COUNT silent fallback patterns (|| config.*) on format/since/focus/window values. Invalid input should be rejected, not silently defaulted:"
  echo "$SILENT_DEFAULT" | head -5 || true
fi

# ---- 31. Validation allow-list vs code handling mismatch ----
echo "[check] Validation allow-lists with unhandled values..."

# Look for _ALLOWED or ALLOWED_VALUES arrays and check if switch/if-else handles all
ALLOW_LISTS=$(grep -rn '_ALLOWED\|ALLOWED_VALUES\|VALID_FORMATS\|VALID_' \
  --include="*.ts" \
  packages/remnic-core/src/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep "const\|let\|=" \
  || true)

if [[ -n "$ALLOW_LISTS" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Extract the variable name
    VAR_NAME=$(echo "$line" | grep -oE '[A-Z_]+_ALLOWED|[A-Z_]+_VALUES' | head -1 || true)
    if [[ -n "$VAR_NAME" ]]; then
      # Count values in the allow list
      ALLOWED_VALUES=$(grep -A5 "$VAR_NAME" "$FILE" 2>/dev/null | grep -oE '"[^"]+"' | sort -u || true)
      ALLOWED_COUNT=$(echo "$ALLOWED_VALUES" | grep -c '"' 2>/dev/null || true)
      ALLOWED_COUNT=${ALLOWED_COUNT:-0}
      if [[ "$ALLOWED_COUNT" -gt 2 ]]; then
        # Check if there's a corresponding switch/if chain with same number of branches
        HANDLED=$(grep -c "case\|===\|==" "$FILE" 2>/dev/null || true)
        HANDLED=${HANDLED:-0}
        if [[ "$HANDLED" -lt "$ALLOWED_COUNT" ]]; then
          warn "$FILE — $VAR_NAME has $ALLOWED_COUNT values but file only has $HANDLED case/branch handlers. Validator may accept values that code doesn't handle."
        fi
      fi
    fi
  done <<< "$ALLOW_LISTS"
fi

# ---- 32. Incomplete status filtering ----
echo "[check] Incomplete status/state filter coverage..."

# Look for status filters that only check some non-active states
STATUS_FILTERS=$(grep -rn 'status.*===\|status.*!==\|\.status\|status ==' \
  --include="*.ts" \
  packages/remnic-core/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -i "superseded\|archived\|active\|rejected\|quarantined\|pending" \
  || true)

if [[ -n "$STATUS_FILTERS" ]]; then
  # Check which statuses appear in filtering code
  HAS_SUPERSEDED=$(echo "$STATUS_FILTERS" | grep -c "superseded" 2>/dev/null || echo "0")
  HAS_ARCHIVED=$(echo "$STATUS_FILTERS" | grep -c "archived" 2>/dev/null || echo "0")
  HAS_QUARANTINED=$(echo "$STATUS_FILTERS" | grep -c "quarantined" 2>/dev/null || echo "0")
  HAS_REJECTED=$(echo "$STATUS_FILTERS" | grep -c "rejected" 2>/dev/null || echo "0")

  # If filtering superseded/archived but not quarantined/rejected, flag it
  if [[ "$HAS_SUPERSEDED" -gt 0 ]] && [[ "$HAS_ARCHIVED" -gt 0 ]] && [[ "$HAS_QUARANTINED" -eq 0 ]]; then
    warn "Status filters mention superseded/archived but not quarantined. Consider using an explicit ACTIVE_STATUSES set to cover all non-active states."
  fi
  if [[ "$HAS_SUPERSEDED" -gt 0 ]] && [[ "$HAS_ARCHIVED" -gt 0 ]] && [[ "$HAS_REJECTED" -eq 0 ]]; then
    warn "Status filters mention superseded/archived but not rejected. Consider using an explicit ACTIVE_STATUSES set to cover all non-active states."
  fi
fi

# ---- 33. Non-atomic file replace (rmSync then renameSync) ----
echo "[check] Non-atomic file replace patterns..."

ATOMIC_ISSUE=$(grep -rn 'rmSync\|rm -rf\|unlinkSync\|removeSync' \
  --include="*.ts" \
  packages/remnic-core/src/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$ATOMIC_ISSUE" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if a renameSync follows within 5 lines of the rmSync
    if sed -n "$((LINENUM)),$((LINENUM+5))p" "$FILE" 2>/dev/null | grep -q "renameSync\|rename(" ; then
      warn "$FILE:$LINENUM — rmSync/removeSync followed by renameSync within 5 lines. This is non-atomic; use write-to-temp-then-rename instead."
    fi
  done <<< "$ATOMIC_ISSUE"
fi

# ---- 34. CI workflow dispatch without branch protection ----
echo "[check] CI publish workflows missing branch protection..."

if compgen -G ".github/workflows/*.yml" >/dev/null 2>&1 || compgen -G ".github/workflows/*.yaml" >/dev/null 2>&1; then
  PUBLISH_WORKFLOWS=$(grep -l 'workflow_dispatch\|publish\|deploy\|release' \
    .github/workflows/*.yml .github/workflows/*.yaml \
    2>/dev/null || true)

  if [[ -n "$PUBLISH_WORKFLOWS" ]]; then
    while IFS= read -r wf; do
      HAS_DISPATCH=$(grep -c 'workflow_dispatch' "$wf" 2>/dev/null || true)
      HAS_BRANCH_CHECK=$(grep -c "github.ref\|github.base_ref\|'refs/heads/main'" "$wf" 2>/dev/null || true)
      HAS_DISPATCH=${HAS_DISPATCH:-0}
      HAS_BRANCH_CHECK=${HAS_BRANCH_CHECK:-0}
      if [[ "$HAS_DISPATCH" -gt 0 ]] && [[ "$HAS_BRANCH_CHECK" -eq 0 ]]; then
        warn "$wf — has workflow_dispatch trigger but no github.ref branch check. Manual dispatch can target any branch, allowing unintended publishes."
      fi
    done <<< "$PUBLISH_WORKFLOWS"
  fi
fi


# ---- 35. slice(-variable) without zero-guard (CLAUDE.md rule 27) ----
echo "[check] slice(-variable) without zero-guard..."

# Rule 27: .slice(-n) where n could be 0 returns ALL elements (slice(-0) ===
# slice(0)). Flag .slice(- followed by a letter (variable name). Literal
# negative offsets like .slice(-3) are safe and excluded. WARN-level because
# ~20 existing call sites use computed offsets (often guarded by Math.max(1,...)
# above); new violations should add a guard or justify the safety.
SLICE_NEG_VAR=$(grep -rnE '\.slice\(-[a-zA-Z_]' \
  --include="*.ts" \
  packages/remnic-core/src/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "//.*slice" \
  | grep -v "\\*.*slice" \
  || true)

if [[ -n "$SLICE_NEG_VAR" ]]; then
  while IFS= read -r line; do
    warn "$line — .slice(-variable) without zero-guard (rule 27). slice(-0) returns ALL elements. Guard with if (n <= 0) or use a literal."
  done <<< "$SLICE_NEG_VAR"
fi

# ---- 36. Cross-package relative imports instead of package name (CLAUDE.md rule 26) ----
echo "[check] Cross-package relative imports (BLOCKING)..."

# Rule 26: import from "@remnic/core", not "../../../remnic-core/src/foo".
# Also covers @remnic/cli and @remnic/server.
# Relative cross-package imports break silently on directory renames and hide
# package dependency signals. Flag any import using ../ that reaches into
# another package's src directory.
CROSS_PKG_IMPORTS=$(grep -rnE 'from .*\.\..*remnic-(core|cli|server)/src' \
  --include="*.ts" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  || true)

if [[ -n "$CROSS_PKG_IMPORTS" ]]; then
  while IFS= read -r line; do
    fail "$line — cross-package relative import (rule 26). Use import from \"@remnic/core\" instead."
  done <<< "$CROSS_PKG_IMPORTS"
fi

# ---- 37. Ad-hoc non-active status exclusion (CLAUDE.md rule 53) ----
echo "[check] Ad-hoc non-active status exclusion lists..."

# Rule 53: code that enumerates 2+ non-active status string literals
# (superseded, archived, quarantined, rejected, forgotten, pending_review)
# as an exclusion list without referencing ACTIVE_STATUSES is fragile —
# adding a new status means every such site must be updated individually.
# Use the shared ACTIVE_STATUSES set from contradiction-scan.ts instead.
# WARN-level — existing sites need migration to ACTIVE_STATUSES over time.
# Patterns for non-active status string literal comparisons.
# RULE53_RE: direct status ===/!== comparisons. Uses (^|[^.]) before bare
# 'status' to exclude property accesses like settled.status (Promise.allSettled
# results) that are NOT memory lifecycle filters. frontmatter.status matched
# separately since the dot is expected.
# RULE53_ARRAY_RE: array-based exclusion lists like
# ["superseded", "archived"].includes(status) — same anti-pattern, different
# syntax.
RULE53_RE='((^|[^.])status|frontmatter\.status)\s*(===|!==)\s*"(superseded|archived|quarantined|rejected|forgotten|pending_review)"'
RULE53_ARRAY_RE='"(superseded|archived|quarantined|rejected|forgotten|pending_review)"\s*,\s*"(superseded|archived|quarantined|rejected|forgotten|pending_review)"'

# Get files with at least one match (either pattern)
ADHOC_STATUS_FILES=$(grep -rlE "$RULE53_RE|$RULE53_ARRAY_RE" \
  --include="*.ts" \
  packages/remnic-core/src/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  || true)

# For each file, count total matches from both patterns.
# No file-level ACTIVE_STATUSES skip — a file can import the set for one
# function while still having ad-hoc comparisons in another. The WARN
# nudges migration; each site is visible to reviewers.
if [[ -n "$ADHOC_STATUS_FILES" ]]; then
  while IFS= read -r f; do
    DIRECT=$( { grep -noE "$RULE53_RE" "$f" 2>/dev/null || true; } | wc -l | tr -d ' ')
    ARRAY=$( { grep -noE "$RULE53_ARRAY_RE" "$f" 2>/dev/null | grep -vi 'enum' || true; } | wc -l | tr -d ' ')
    COUNT=$((DIRECT + ARRAY))
    if [[ "$COUNT" -ge 2 ]]; then
      warn "$f — enumerates $COUNT non-active status literals without ACTIVE_STATUSES (rule 53). Use the shared set from contradiction-scan.ts."
      { grep -nE "$RULE53_RE|$RULE53_ARRAY_RE" "$f" 2>/dev/null || true; } | head -5 | sed 's/^/    /'
    fi
  done <<< "$ADHOC_STATUS_FILES"
fi



# ---- 38. existsSync on directory-typed args without isDirectory (CLAUDE.md rule 24) ----
echo "[check] existsSync on directory paths without isDirectory() check..."

# Rule 24: existsSync() returns true for files. When a directory is expected
# (an argument whose name contains Dir/Folder/memoryDir), guard with
# statSync().isDirectory(). Accepting a file as memoryDir produces a broken
# install that only fails later. WARN-level.
EXISTSYNC_DIR=$(grep -rnE 'existsSync\(\s*\w*(Dir|Folder|memoryDir)\w*' \
  --include="*.ts" \
  packages/remnic-core/src/ packages/remnic-cli/src/ packages/remnic-server/src/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  | grep -v "isDirectory" \
  || true)

if [[ -n "$EXISTSYNC_DIR" ]]; then
  EC=$(echo "$EXISTSYNC_DIR" | wc -l | tr -d ' ')
  warn "$EC site(s) call existsSync() on a *Dir/*Folder variable without an isDirectory() guard (rule 24). Use statSync().isDirectory() when a directory is expected."
  echo "$EXISTSYNC_DIR" | head -10 | sed 's/^/    /'
fi

# ---- 39. Optional packages bundled into a base install (CLAUDE.md rule 57) ----
echo "[check] Optional packages in base dependencies/noExternal..."

# Rule 57: every package declared optional in peerDependenciesMeta must stay
# à-la-carte — loaded via computed-specifier dynamic imports, never listed in a
# base package's runtime dependencies or tsup noExternal. Driven by each
# package's OWN peerDependenciesMeta so every optional peer is covered
# automatically (bench, weclone, all @remnic/import-*, connectors, coding-graph,
# plugins…), not a hardcoded subset. BLOCKING — a regression silently forces
# every user to install optional weight they did not ask for.
for base in remnic-core remnic-cli remnic-server; do
  pj="packages/$base/package.json"
  [[ -f "$pj" ]] || continue
  OPT_IN_DEPS=$(node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const deps = Object.keys(p.dependencies || {});
    const opt = Object.entries(p.peerDependenciesMeta || {})
      .filter(([, v]) => v && v.optional).map(([k]) => k);
    for (const k of opt) if (deps.includes(k)) console.log(k);
  ' "$pj" 2>/dev/null || true)
  if [[ -n "$OPT_IN_DEPS" ]]; then
    fail "$pj lists optional peer(s) in dependencies (rule 57): $OPT_IN_DEPS — keep them optional via peerDependenciesMeta + computed-specifier dynamic import."
  fi
done
# tsup: optional peers (from peerDependenciesMeta) must NOT be in noExternal.
# Listing them in the `external` array is CORRECT (keeps them unbundled) and is
# explicitly exempt — only the noExternal array is checked.
for tcfg in packages/remnic-core/tsup.config.* packages/remnic-cli/tsup.config.* packages/remnic-server/tsup.config.*; do
  [[ -f "$tcfg" ]] || continue
  tpj="$(dirname "$tcfg")/package.json"
  [[ -f "$tpj" ]] || continue
  OPT_LIST=$(node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(Object.entries(p.peerDependenciesMeta || {}).filter(([,v])=>v&&v.optional).map(([k])=>k).join(" "));
  ' "$tpj" 2>/dev/null || true)
  [[ -n "$OPT_LIST" ]] || continue
  NOEXT_BODY=$(awk '/noExternal[[:space:]]*:[[:space:]]*\[/{f=1;next} f&&/\]/{f=0} f' "$tcfg" 2>/dev/null || true)
  [[ -n "$NOEXT_BODY" ]] || continue
  for opt in $OPT_LIST; do
    if echo "$NOEXT_BODY" | grep -qF "$opt"; then
      fail "$tcfg lists $opt in noExternal (rule 57). Optional peers must stay external/omitted, never bundled."
    fi
  done
done

# ---- 40. ENGRAM_ env var read without REMNIC_ fallback (CLAUDE.md rule 9) ----
echo "[check] ENGRAM_ env reads missing REMNIC_ fallback..."

# Rule 9: always try REMNIC_* first, then fall back to ENGRAM_*. An ENGRAM_
# read without a REMNIC_ partner on the same or preceding 2 lines is the
# legacy-fallback anti-pattern. WARN-level — zero current violations; guards
# against regressions when new env-var plumbing is added.
ENGRA_READS=$(grep -rnE 'process\.env\.ENGRAM_' \
  --include="*.ts" --include="*.cjs" --include="*.mjs" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)
ENGRA_VIOLS=""
if [[ -n "$ENGRA_READS" ]]; then
  while IFS=: read -r ef en erest; do
    [[ -n "$ef" ]] || continue
    ectxa=$(awk -v n="$en" 'NR>=n-2 && NR<=n' "$ef" 2>/dev/null)
    if ! echo "$ectxa" | grep -q "REMNIC_"; then
      ENGRA_VIOLS="${ENGRA_VIOLS}${ef}:${en} ${erest}\n"
    fi
  done <<< "$ENGRA_READS"
fi
if [[ -n "$(printf '%s' "$ENGRA_VIOLS" | tr -d '[:space:]')" ]]; then
  warn "ENGRAM_ env read(s) without a REMNIC_ fallback within 2 lines (rule 9):"
  printf '%b' "$ENGRA_VIOLS" | awk 'NF' | head -10 | sed 's/^/    /'
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "[check] FAILED — $ERRORS issue(s) found. Fix before pushing."
  exit 1
else
  echo "[check] PASSED — no review-pattern issues detected"
  exit 0
fi
