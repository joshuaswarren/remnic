/**
 * Structural wiring test for the peer profile reasoner — issue #679 PR 2/5.
 *
 * The reasoner runs as a post-consolidation hook in the REM phase
 * (`runSemanticConsolidation` in `orchestrator.ts`). The full
 * orchestrator is too heavy for a unit test, so we verify the wiring
 * structurally: the reasoner call site must exist, must be gated on
 * `peerProfileReasonerEnabled`, and must fire AFTER the materialize
 * post-hook so the materialized snapshot is not stale-shadowed by a
 * later peer-profile write.
 *
 * If a future refactor drops the gate or re-orders the calls, the
 * assertions below fail loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

test("orchestrator REM phase invokes the peer profile reasoner gated on the config flag", () => {
  // Issue #1526 seam 5: semantic consolidation moved to SemanticConsolidationCoordinator.
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/semantic-consolidation-coordinator.ts"),
    "utf-8",
  );
  // Gate must exist verbatim so a typo on the flag silently disabling
  // the reasoner is impossible.
  assert.match(
    src,
    /if \(this\.config\.peerProfileReasonerEnabled\)/,
    "coordinator must gate the reasoner on `peerProfileReasonerEnabled`",
  );
  // Static import (coordinator module uses static imports per repo rules).
  assert.match(
    src,
    /from "\.\.\/peers\/index\.js"/,
    "coordinator must statically import the peers barrel",
  );
  assert.match(
    src,
    /runPeerProfileReasoner\(/,
    "coordinator must call runPeerProfileReasoner",
  );
});

test("orchestrator runs the peer profile reasoner AFTER the materialize post-hook", () => {
  // Issue #1526 seam 5: semantic consolidation moved to SemanticConsolidationCoordinator.
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/semantic-consolidation-coordinator.ts"),
    "utf-8",
  );
  const materializeIdx = src.indexOf("await materializeAfterSemanticConsolidation(");
  const reasonerIdx = src.indexOf("runPeerProfileReasoner(");
  assert.ok(materializeIdx > 0, "materialize call must exist");
  assert.ok(reasonerIdx > 0, "reasoner call must exist");
  assert.ok(
    reasonerIdx > materializeIdx,
    "reasoner must run after materialize so the materialized snapshot is consistent",
  );
});

test("config defaults expose peerProfileReasoner* keys with least-privileged defaults", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/config.ts"),
    "utf-8",
  );
  // Default-off (Gotcha #48 — least-privileged default).
  assert.match(
    src,
    /peerProfileReasonerEnabled:\s*\n\s*coerceBool\(cfg\.peerProfileReasonerEnabled\) \?\? false/,
    "peerProfileReasonerEnabled must default to false via coerceBool",
  );
  // Numeric clamps must accept 0 (Gotcha #45 — schema documents 0 as
  // a disable value, code path must honour it). After cursor L #736
  // we route via the shared `coerceNonNegativeInt` helper so string
  // CLI values are coerced uniformly with sibling numeric keys
  // (Gotcha #28).
  assert.match(
    src,
    /peerProfileReasonerMinInteractions:\s*coerceNonNegativeInt\(\s*cfg\.peerProfileReasonerMinInteractions,/,
    "min-interactions must route via coerceNonNegativeInt for string CLI coercion",
  );
  assert.match(
    src,
    /peerProfileReasonerMaxFieldsPerRun:\s*coerceNonNegativeInt\(\s*cfg\.peerProfileReasonerMaxFieldsPerRun,/,
    "max-fields must route via coerceNonNegativeInt for string CLI coercion",
  );
});

test("plugin manifest exposes peerProfileReasoner* keys with matching defaults", () => {
  for (const rel of [
    "openclaw.plugin.json",
    "packages/plugin-openclaw/openclaw.plugin.json",
  ]) {
    const raw = readFileSync(path.join(repoRoot, rel), "utf-8");
    const json = JSON.parse(raw);
    const cfg = json.configSchema?.properties ?? json.configSchema?.properties;
    assert.ok(cfg, `${rel} must expose configSchema.properties`);
    assert.equal(
      cfg.peerProfileReasonerEnabled?.default,
      false,
      `${rel}: peerProfileReasonerEnabled default must be false`,
    );
    // Cursor M #736: model default must be the routing alias "auto",
    // not a hardcoded model identifier. Matches sibling
    // semanticConsolidationModel convention.
    assert.equal(
      cfg.peerProfileReasonerModel?.default,
      "auto",
      `${rel}: peerProfileReasonerModel default must be "auto"`,
    );
    assert.equal(
      cfg.peerProfileReasonerMinInteractions?.default,
      5,
      `${rel}: peerProfileReasonerMinInteractions default must be 5`,
    );
    assert.equal(
      cfg.peerProfileReasonerMinInteractions?.minimum,
      0,
      `${rel}: peerProfileReasonerMinInteractions minimum must be 0 to honour disable`,
    );
    assert.equal(
      cfg.peerProfileReasonerMaxFieldsPerRun?.default,
      8,
      `${rel}: peerProfileReasonerMaxFieldsPerRun default must be 8`,
    );
    assert.equal(
      cfg.peerProfileReasonerMaxFieldsPerRun?.minimum,
      0,
      `${rel}: peerProfileReasonerMaxFieldsPerRun minimum must be 0 to honour disable`,
    );
  }
});
