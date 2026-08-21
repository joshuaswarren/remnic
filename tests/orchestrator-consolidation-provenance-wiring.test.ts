/**
 * Structural wiring test for semantic-consolidation provenance (issue #561
 * PR 2).
 *
 * PR 2 adds a call to `storage.snapshotForProvenance(m.path)` for every
 * source memory in a consolidation cluster, and threads the resulting
 * entries through to `storage.writeMemory(...)` via the `derivedFrom` +
 * `derivedVia` options.  The full orchestrator is too heavy to spin up in
 * a unit test, so we verify the wiring structurally: the call sites must
 * exist in the expected file, adjacent to the consolidation write path.
 *
 * If someone refactors the consolidation loop and drops the snapshot call,
 * the new memory loses its `derived_from` pointers silently — these
 * assertions fail loudly instead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

test("orchestrator semantic-consolidation loop snapshots sources before the canonical write", () => {
  // Issue #1526 seam 5: semantic consolidation moved to SemanticConsolidationCoordinator.
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/semantic-consolidation-coordinator.ts"),
    "utf-8",
  );
  // The consolidation block must call snapshotForProvenance on each
  // source memory.  We look for the distinctive call site rather than the
  // method name alone so refactors that move the call elsewhere still
  // flag up.
  assert.match(
    src,
    /snapshotForProvenance\(m\.path\)/u,
    "coordinator must call storage.snapshotForProvenance(m.path) inside the consolidation loop",
  );

  // The derivedFrom + derivedVia options must be passed to writeMemory in
  // the same function body.  We anchor by the semantic-consolidation
  // source tag to avoid matching unrelated call sites (e.g. future PRs
  // that wire supersession or dedup paths).
  const sourceAnchor = src.indexOf('source: "semantic-consolidation"');
  assert.ok(sourceAnchor >= 0, "coordinator consolidation writeMemory call must survive");
  const window = src.slice(Math.max(0, sourceAnchor - 2000), sourceAnchor + 2000);
  assert.match(
    window,
    /derivedFrom:/u,
    "consolidation writeMemory call must pass derivedFrom",
  );
  assert.match(
    window,
    /derivedVia:/u,
    "consolidation writeMemory call must pass derivedVia",
  );
});

test("storage.ts declares derivedFrom + derivedVia on the writeMemory options surface", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/storage.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /derivedFrom\?:\s*string\[\]/u,
    "writeMemory options must accept derivedFrom: string[]",
  );
  assert.match(
    src,
    /derivedVia\?:\s*ConsolidationOperator/u,
    "writeMemory options must accept derivedVia: ConsolidationOperator",
  );
  assert.match(
    src,
    /async snapshotForProvenance\(/u,
    "storage must expose snapshotForProvenance()",
  );
});
