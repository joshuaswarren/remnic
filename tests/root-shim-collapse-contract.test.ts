import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Phase 2 of the root-shim collapse (#2801 phase 2 / #2913): every root
// package.json export whose implementation was only a re-export of an
// @remnic/core subpath now points directly at the workspace core build and
// source contract (./packages/remnic-core/<same conditions as core>). This
// suite pins that collapsed state so it cannot silently regress.

const repoRoot = new URL("../", import.meta.url);

/** Every public export name preserved by the collapse. Shrink-only: a name
 *  leaves this list only by deleting it from package.json in the same change. */
const EXPECTED_EXPORT_NAMES: Record<string, true> = {
  ".": true,
  "./access-cli": true,
  "./access-cli.js": true,
  "./adapters": true,
  "./adapters.js": true,
  "./adapters/claude-code": true,
  "./adapters/claude-code.js": true,
  "./adapters/codex": true,
  "./adapters/codex.js": true,
  "./adapters/hermes": true,
  "./adapters/hermes.js": true,
  "./adapters/index": true,
  "./adapters/index.js": true,
  "./adapters/registry": true,
  "./adapters/registry.js": true,
  "./adapters/replit": true,
  "./adapters/replit.js": true,
  "./adapters/types": true,
  "./adapters/types.js": true,
  "./cli": true,
  "./cli.js": true,
  "./compat/checks": true,
  "./compat/checks.js": true,
  "./compat/types": true,
  "./compat/types.js": true,
  "./connectors": true,
  "./connectors.js": true,
  "./connectors/codex-materialize": true,
  "./connectors/codex-materialize-runner": true,
  "./connectors/codex-materialize-runner.js": true,
  "./connectors/codex-materialize.js": true,
  "./consolidation-operator": true,
  "./consolidation-operator.js": true,
  "./consolidation-provenance-check": true,
  "./consolidation-provenance-check.js": true,
  "./consolidation-undo": true,
  "./consolidation-undo.js": true,
  "./conversation-index/backend": true,
  "./conversation-index/backend.js": true,
  "./conversation-index/chunker": true,
  "./conversation-index/chunker.js": true,
  "./conversation-index/cleanup": true,
  "./conversation-index/cleanup.js": true,
  "./conversation-index/faiss-adapter": true,
  "./conversation-index/faiss-adapter.js": true,
  "./conversation-index/indexer": true,
  "./conversation-index/indexer.js": true,
  "./conversation-index/search": true,
  "./conversation-index/search.js": true,
  "./delinearize": true,
  "./delinearize.js": true,
  "./embedding-fallback": true,
  "./embedding-fallback.js": true,
  "./enrichment": true,
  "./enrichment.js": true,
  "./entity-retrieval": true,
  "./entity-retrieval.js": true,
  "./evals": true,
  "./evals.js": true,
  "./explicit-capture": true,
  "./explicit-capture.js": true,
  "./extraction": true,
  "./extraction.js": true,
  "./fallback-llm": true,
  "./fallback-llm.js": true,
  "./graph": true,
  "./graph-dashboard-diff": true,
  "./graph-dashboard-diff.js": true,
  "./graph-dashboard-key": true,
  "./graph-dashboard-key.js": true,
  "./graph-dashboard-parser": true,
  "./graph-dashboard-parser.js": true,
  "./graph-edge-reinforcement": true,
  "./graph-edge-reinforcement.js": true,
  "./graph-events": true,
  "./graph-events.js": true,
  "./graph-snapshot": true,
  "./graph-snapshot.js": true,
  "./graph.js": true,
  "./harmonic-retrieval": true,
  "./harmonic-retrieval.js": true,
  "./himem": true,
  "./himem.js": true,
  "./hygiene": true,
  "./hygiene.js": true,
  "./identity-continuity": true,
  "./identity-continuity.js": true,
  "./importance": true,
  "./importance.js": true,
  "./json-store": true,
  "./json-store.js": true,
  "./lcm": true,
  "./lcm.js": true,
  "./lcm/archive": true,
  "./lcm/archive.js": true,
  "./lcm/dag": true,
  "./lcm/dag.js": true,
  "./lcm/engine": true,
  "./lcm/engine.js": true,
  "./lcm/index": true,
  "./lcm/index.js": true,
  "./lcm/queue": true,
  "./lcm/queue.js": true,
  "./lcm/recall": true,
  "./lcm/recall.js": true,
  "./lcm/schema": true,
  "./lcm/schema.js": true,
  "./lcm/summarizer": true,
  "./lcm/summarizer.js": true,
  "./lcm/tools": true,
  "./lcm/tools.js": true,
  "./maintenance/archive-observations": true,
  "./maintenance/archive-observations.js": true,
  "./maintenance/backup-stamp": true,
  "./maintenance/backup-stamp.js": true,
  "./maintenance/memory-governance": true,
  "./maintenance/memory-governance-cron": true,
  "./maintenance/memory-governance-cron.js": true,
  "./maintenance/memory-governance.js": true,
  "./maintenance/migrate-observations": true,
  "./maintenance/migrate-observations.js": true,
  "./maintenance/observation-ledger-utils": true,
  "./maintenance/observation-ledger-utils.js": true,
  "./maintenance/rebuild-memory-lifecycle-ledger": true,
  "./maintenance/rebuild-memory-lifecycle-ledger.js": true,
  "./maintenance/rebuild-memory-projection": true,
  "./maintenance/rebuild-memory-projection.js": true,
  "./maintenance/rebuild-observations": true,
  "./maintenance/rebuild-observations.js": true,
  "./memory-projection-format": true,
  "./memory-projection-format.js": true,
  "./memory-projection-store": true,
  "./memory-projection-store.js": true,
  "./migrate/from-engram": true,
  "./migrate/from-engram.js": true,
  "./model-registry": true,
  "./model-registry.js": true,
  "./models-json": true,
  "./models-json.js": true,
  "./namespaces/migrate": true,
  "./namespaces/migrate.js": true,
  "./namespaces/principal": true,
  "./namespaces/principal.js": true,
  "./namespaces/search": true,
  "./namespaces/search.js": true,
  "./namespaces/storage": true,
  "./namespaces/storage.js": true,
  "./openai-chat-compat": true,
  "./openai-chat-compat.js": true,
  "./operator-toolkit": true,
  "./operator-toolkit.js": true,
  "./opik-exporter": true,
  "./opik-exporter.js": true,
  "./orchestrator": true,
  "./orchestrator.js": true,
  "./profiling": true,
  "./profiling.js": true,
  "./qmd": true,
  "./qmd-recall-cache": true,
  "./qmd-recall-cache.js": true,
  "./qmd.js": true,
  "./reconstruct": true,
  "./reconstruct.js": true,
  "./relevance": true,
  "./relevance.js": true,
  "./replay/normalizers/chatgpt": true,
  "./replay/normalizers/chatgpt.js": true,
  "./replay/normalizers/claude": true,
  "./replay/normalizers/claude.js": true,
  "./replay/normalizers/openclaw": true,
  "./replay/normalizers/openclaw.js": true,
  "./replay/normalizers/shared": true,
  "./replay/normalizers/shared.js": true,
  "./replay/runner": true,
  "./replay/runner.js": true,
  "./replay/types": true,
  "./replay/types.js": true,
  "./rerank": true,
  "./rerank.js": true,
  "./resume-bundles": true,
  "./resume-bundles.js": true,
  "./retrieval": true,
  "./retrieval-agents": true,
  "./retrieval-agents.js": true,
  "./retrieval.js": true,
  "./routing/engine": true,
  "./routing/engine.js": true,
  "./routing/store": true,
  "./routing/store.js": true,
  "./runtime/better-sqlite": true,
  "./runtime/better-sqlite.js": true,
  "./runtime/child-process": true,
  "./runtime/child-process.js": true,
  "./runtime/env": true,
  "./runtime/env.js": true,
  "./sanitize": true,
  "./sanitize.js": true,
  "./schemas": true,
  "./schemas.js": true,
  "./sdk-compat": true,
  "./sdk-compat.js": true,
  "./search": true,
  "./search.js": true,
  "./search/document-scanner": true,
  "./search/document-scanner.js": true,
  "./search/embed-helper": true,
  "./search/embed-helper.js": true,
  "./search/factory": true,
  "./search/factory.js": true,
  "./search/index": true,
  "./search/index.js": true,
  "./search/lancedb-backend": true,
  "./search/lancedb-backend.js": true,
  "./search/meilisearch-backend": true,
  "./search/meilisearch-backend.js": true,
  "./search/noop-backend": true,
  "./search/noop-backend.js": true,
  "./search/orama-backend": true,
  "./search/orama-backend.js": true,
  "./search/port": true,
  "./search/port.js": true,
  "./search/remote-backend": true,
  "./search/remote-backend.js": true,
  "./secure-store": true,
  "./secure-store.js": true,
  "./secure-store/index": true,
  "./secure-store/index.js": true,
  "./session-integrity": true,
  "./session-integrity.js": true,
  "./session-observer-bands": true,
  "./session-observer-bands.js": true,
  "./session-observer-state": true,
  "./session-observer-state.js": true,
  "./shared-context/manager": true,
  "./shared-context/manager.js": true,
  "./signal": true,
  "./signal.js": true,
  "./source-attribution": true,
  "./source-attribution.js": true,
  "./store-contract": true,
  "./store-contract.js": true,
  "./summarizer": true,
  "./summarizer.js": true,
  "./summary-snapshot": true,
  "./summary-snapshot.js": true,
  "./temporal-index": true,
  "./temporal-index.js": true,
  "./temporal-validity": true,
  "./temporal-validity.js": true,
  "./threading": true,
  "./threading.js": true,
  "./tier-migration": true,
  "./tier-migration.js": true,
  "./tier-routing": true,
  "./tier-routing.js": true,
  "./tmt": true,
  "./tmt.js": true,
  "./topics": true,
  "./topics.js": true,
  "./transcript": true,
  "./transcript.js": true,
  "./transfer/autodetect": true,
  "./transfer/autodetect.js": true,
  "./transfer/backup": true,
  "./transfer/backup.js": true,
  "./transfer/capsule-export": true,
  "./transfer/capsule-export.js": true,
  "./transfer/capsule-import": true,
  "./transfer/capsule-import.js": true,
  "./transfer/constants": true,
  "./transfer/constants.js": true,
  "./transfer/export-json": true,
  "./transfer/export-json.js": true,
  "./transfer/export-md": true,
  "./transfer/export-md.js": true,
  "./transfer/export-sqlite": true,
  "./transfer/export-sqlite.js": true,
  "./transfer/fs-utils": true,
  "./transfer/fs-utils.js": true,
  "./transfer/import-json": true,
  "./transfer/import-json.js": true,
  "./transfer/import-md": true,
  "./transfer/import-md.js": true,
  "./transfer/import-sqlite": true,
  "./transfer/import-sqlite.js": true,
  "./transfer/sqlite-schema": true,
  "./transfer/sqlite-schema.js": true,
  "./transfer/types": true,
  "./transfer/types.js": true,
  "./trust-zones": true,
  "./trust-zones.js": true,
  "./types": true,
  "./types.js": true,
  "./utility-learner": true,
  "./utility-learner.js": true,
  "./utility-telemetry": true,
  "./utility-telemetry.js": true,
  "./work/board": true,
  "./work/board.js": true,
  "./work/boundary": true,
  "./work/boundary.js": true,
  "./work/storage": true,
  "./work/storage.js": true,
  "./work/types": true,
  "./work/types.js": true,
};

/** The only root tsup entries that may exist after the collapse. */
const EXPECTED_TSUP_ENTRIES = ["src/explicit-capture.ts", "src/index.ts"];

/** Export names still targeting root ./dist (real root-built code). */
const DIST_TARGETED_EXPORT_ALLOWLIST: Record<string, true> = {
  ".": true,
  "./explicit-capture": true,
  "./explicit-capture.js": true,
};

/** A tsup entry is copy-only when every statement re-exports one core subpath. */
function isCopyOnlyCoreShim(source: string): boolean {
  const joined = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .join(" ");
  if (joined.length === 0) return false;
  const statementRe = /^export (?:type )?\{[^}]*\} from "@remnic\/core\/[^"]+"$/;
  return joined.split(";").every((part) => {
    const statement = part.trim();
    return statement.length === 0 || statementRe.test(statement);
  });
}

function readTsupEntries(): string[] {
  const tsupConfig = readFileSync(new URL("../tsup.config.ts", import.meta.url), "utf8");
  return [...tsupConfig.matchAll(/"(src\/[^"]+\.ts)"/g)].map((m) => m[1]);
}

async function readRootExports(): Promise<Record<string, Record<string, string>>> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, Record<string, string>>;
  };
  return packageJson.exports ?? {};
}

test("zero tsup entries whose sole job is copying a core module", () => {
  const entries = readTsupEntries();
  assert.deepEqual([...entries].sort(), [...EXPECTED_TSUP_ENTRIES].sort());

  for (const entry of entries) {
    const source = readFileSync(new URL("../" + entry, import.meta.url), "utf8");
    assert.equal(isCopyOnlyCoreShim(source), false, entry);
  }
});

test("root export names are exactly the preserved public surface", async () => {
  const exportsMap = await readRootExports();
  assert.deepEqual(
    [...Object.keys(exportsMap)].sort(),
    Object.keys(EXPECTED_EXPORT_NAMES).sort(),
  );
});

test("every collapsed export targets the workspace core contract", async () => {
  const corePackageJson = JSON.parse(
    await readFile(new URL("../packages/remnic-core/package.json", import.meta.url), "utf8"),
  ) as { exports?: Record<string, Record<string, string>> };
  const coreTargets = new Set<string>();
  for (const conditions of Object.values(corePackageJson.exports ?? {})) {
    for (const target of Object.values(conditions)) {
      if (typeof target === "string") coreTargets.add(target);
    }
  }

  const exportsMap = await readRootExports();
  for (const [name, conditions] of Object.entries(exportsMap)) {
    if (name in DIST_TARGETED_EXPORT_ALLOWLIST) continue;
    for (const target of Object.values(conditions)) {
      assert.match(target, /^\.\/packages\/remnic-core\//, name);
      assert.ok(coreTargets.has(target.replace("./packages/remnic-core/", "./")), name);
    }
    const remnicSource = conditions["remnic-source"];
    assert.ok(remnicSource, name);
    assert.equal(existsSync(new URL(remnicSource, repoRoot)), true, name);
  }
});

test("remaining root-dist exports stay within the allowlist", async () => {
  const exportsMap = await readRootExports();
  const distTargeted = Object.entries(exportsMap)
    .filter(([, conditions]) => (conditions.import ?? "").startsWith("./dist/"))
    .map(([name]) => name);
  for (const name of distTargeted) {
    assert.ok(name in DIST_TARGETED_EXPORT_ALLOWLIST, name);
  }
});

test("representative subpaths resolve identically through root and core", async () => {
  // Dynamic import is the point: this test exercises the module-loading
  // boundary between the root export map and the core package, so static
  // imports cannot prove the identity under test.
  for (const subpath of ["transfer/constants", "types", "sanitize", "lcm/schema"] as const) {
    assert.equal(
      import.meta.resolve(`remnic-workspace/${subpath}`),
      import.meta.resolve(`@remnic/core/${subpath}`),
      subpath,
    );
    const viaRoot = await import(`remnic-workspace/${subpath}`);
    const viaCore = await import(`@remnic/core/${subpath}`);
    assert.equal(viaRoot, viaCore, subpath);
  }

  const constants = await import("@remnic/core/transfer/constants");
  assert.ok(Object.keys(constants).length > 0);
});
