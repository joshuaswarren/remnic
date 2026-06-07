/**
 * codex-materialize-consolidation-wiring.test.ts — regression guard for
 * PR #392 review feedback (thread PRRT_kwDORJXyws56TH1B): the
 * `materializeAfterSemanticConsolidation` and `materializeAfterCausalConsolidation`
 * helpers were defined but never called from the active consolidation code
 * paths, so `codexMaterializeOnConsolidation=true` was effectively inert.
 *
 * The full orchestrator integration path is too heavy to spin up in a unit
 * test, so we check the call sites structurally by reading the relevant
 * source files. If someone refactors the consolidation runtime and forgets
 * to re-wire the hook, these tests fail loudly at build time.
 *
 * This file uses synthetic read-only file inspection — no network, no real
 * user data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

test("orchestrator.runSemanticConsolidation invokes materializeAfterSemanticConsolidation", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestrator.ts"),
    "utf-8",
  );
  // The import line must exist…
  assert.match(
    src,
    /materializeAfterSemanticConsolidation/u,
    "orchestrator.ts must import materializeAfterSemanticConsolidation",
  );
  // …and there must be at least one call site after the semantic-consolidation
  // completion log line. We check by locating the log and asserting a call
  // follows it in the same function body. The helper is awaited so the
  // substring `await materializeAfterSemanticConsolidation` is distinctive.
  const awaitIdx = src.indexOf("await materializeAfterSemanticConsolidation");
  assert.ok(
    awaitIdx >= 0,
    "orchestrator.ts must await materializeAfterSemanticConsolidation at runtime",
  );

  // Sanity: the call is inside a try/catch so a materialize failure never
  // aborts the consolidation result. We check for the presence of a catch
  // block following the call within a small window.
  const window = src.slice(awaitIdx, awaitIdx + 1000);
  assert.match(
    window,
    /catch \(err\)/u,
    "materialize call must be wrapped in try/catch so failures stay non-fatal",
  );
});

test("compounding engine.synthesizeWeekly invokes materializeAfterCausalConsolidation", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/compounding/engine.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /materializeAfterCausalConsolidation/u,
    "compounding/engine.ts must import materializeAfterCausalConsolidation",
  );
  const awaitIdx = src.indexOf("await materializeAfterCausalConsolidation");
  assert.ok(
    awaitIdx >= 0,
    "compounding/engine.ts must await materializeAfterCausalConsolidation at runtime",
  );
  const window = src.slice(awaitIdx, awaitIdx + 1000);
  assert.match(
    window,
    /catch \(materializeError\)/u,
    "causal materialize call must be wrapped in try/catch so failures stay non-fatal",
  );
});

// The two regression guards below moved from the bash hook to the unified
// Node.js runner introduced in issue #1440. The session-end event of
// `remnic-codex-hook.cjs` is the new place where the materializer is invoked.
const codexHookRunner = path.join(
  repoRoot,
  "packages/plugin-codex/hooks/bin/remnic-codex-hook.cjs",
);

test("unified Codex hook runner resolves REMNIC_REPO_ROOT from its own filesystem location", () => {
  // Regression (PR #392 review): the old hook only ran the materializer
  // when either $REMNIC_REPO_ROOT was set OR `remnic --print-root` returned
  // a path. Neither condition holds in most installs, so the materializer
  // silently never ran. The fix resolves relative to the runner's own dir.
  const src = readFileSync(codexHookRunner, "utf-8");
  assert.match(
    src,
    /__dirname/u,
    "runner must resolve root from its own filesystem location (__dirname)",
  );
  // The old reliance on `remnic --print-root` must be gone.
  assert.doesNotMatch(
    src,
    /remnic --print-root/u,
    "runner must not depend on the non-existent `remnic --print-root` flag",
  );
  // Dev fallback path must still verify the candidate root by checking
  // for the dev script before running it.
  assert.match(
    src,
    /scripts\/codex-materialize\.ts/u,
    "runner must verify the candidate root contains scripts/codex-materialize.ts",
  );
});

test("unified Codex hook runner prefers the packaged materialize.cjs binary for distributed installs", () => {
  // Regression (PR #392 review thread PRRT_kwDORJXyws56TOVo): the old hook
  // only knew how to run `scripts/codex-materialize.ts` via tsx, which is
  // never shipped inside any published package payload. The fix ships a
  // packaged CJS wrapper at `packages/plugin-codex/bin/materialize.cjs` and
  // has the hook prefer it before falling back to the dev script.
  const src = readFileSync(codexHookRunner, "utf-8");
  assert.match(
    src,
    /materialize\.cjs/u,
    "runner must reference the packaged materialize.cjs binary",
  );
  assert.match(
    src,
    /REMNIC_CODEX_MATERIALIZE_BIN/u,
    "runner must honor a REMNIC_CODEX_MATERIALIZE_BIN env override",
  );
  // The packaged bin is preferred: its resolution block must appear before
  // the dev-script fallback in the file so distributed installs never hit
  // the tsx shim.
  const binIdx = src.indexOf("materialize.cjs");
  const scriptIdx = src.indexOf("scripts/codex-materialize.ts");
  assert.ok(binIdx >= 0 && scriptIdx >= 0, "both paths must exist");
  assert.ok(
    binIdx < scriptIdx,
    "packaged bin resolution must appear before the dev-script fallback",
  );
});

test("packaged materialize.cjs exists and delegates to @remnic/core", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/plugin-codex/bin/materialize.cjs"),
    "utf-8",
  );
  // Must dynamically import @remnic/core (ESM-only).
  assert.match(
    src,
    /import\(["']@remnic\/core["']\)/u,
    "materialize.cjs must dynamically import @remnic/core",
  );
  // Must call runCodexMaterialize and parseConfig (the public contract the
  // hook depends on).
  assert.match(
    src,
    /runCodexMaterialize/u,
    "materialize.cjs must invoke runCodexMaterialize",
  );
  assert.match(
    src,
    /parseConfig/u,
    "materialize.cjs must invoke parseConfig to build a PluginConfig",
  );
});

test("plugin-codex package ships bin/ and depends on @remnic/core", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/plugin-codex/package.json"), "utf-8"),
  );
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("bin"),
    "plugin-codex package.json must ship the bin/ directory",
  );
  assert.ok(
    pkg.dependencies && pkg.dependencies["@remnic/core"],
    "plugin-codex package.json must declare a @remnic/core runtime dependency",
  );
});

test("@remnic/core re-exports runCodexMaterialize for external consumers", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/index.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /runCodexMaterialize/u,
    "@remnic/core index.ts must export runCodexMaterialize so the packaged bin can import it",
  );
  assert.match(
    src,
    /materializeForNamespace/u,
    "@remnic/core index.ts must export materializeForNamespace",
  );
});
