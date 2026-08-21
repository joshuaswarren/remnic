/**
 * Orchestrator characterization suite (issue #1531, epic #1520).
 *
 * Pins the externally observable three-phase lifecycle contract of the
 * orchestrator BEFORE the #1526 decomposition:
 *
 *   1. Recall  (`before_prompt_build` → `recall()`)
 *   2. Buffer  (`agent_end`          → `processTurn()`)
 *   3. Extract (periodic / forced    → `flushSession()` → `runExtraction`)
 *
 * plus the known edge classes: empty-buffer no-op, dedupe suppression and the
 * `skipDedupeCheck` force-flush bypass (CLAUDE.md rule 29), namespace-routed
 * writes, `before_reset` / `session_end` force flush, restart recovery, and
 * `runQmdMaintenance` unioning configured + cataloged namespaces (#1506 r27).
 *
 * Assertions target OBSERVABLE EFFECTS only — storage writes on disk, catalog
 * `lastWriteAt` touches, and `LastRecallSnapshot` via the public
 * `getLastRecall()` surface — never orchestrator internals. The only seams
 * used are the established ones from orchestrator-flush.test.ts: the
 * `Object.create(Orchestrator.prototype)` + stubbed-fields pattern (for
 * `runQmdMaintenance`) and field-level stubs for the LLM extraction client
 * (`orchestrator.extraction`) so no test ever touches the network.
 *
 * Known trap (issue guide): ALWAYS seed timestamps in the past —
 * `readRecent` uses an exclusive `ts < now` upper bound, so same-millisecond
 * seeds flake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import { resolveNamespaceStorageRoot } from "../src/namespaces/storage.js";
import type { BufferTurn, ExtractionResult, PluginConfig } from "../src/types.js";
import { MaintenanceScheduler } from "../src/orchestration/maintenance.js";

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Offline-safe config: QMD off, embedding fallback off, planner off (so the
 * deterministic filesystem recall scan runs), extraction thresholds floored
 * so single short turns are extractable, and consolidation pushed far out so
 * no test can accidentally schedule a background consolidation run.
 */
function makeConfig(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    // These tests never run initialize() (the gateway_start lifecycle), so
    // the public recall() init gate would otherwise wait its full default
    // timeout on every call. 1000ms is the configured minimum bound.
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

function pastIso(): string {
  // One hour in the past — never the same millisecond as any `now` bound.
  return new Date(Date.now() - 3600_000).toISOString();
}

/** Seed a recallable fact file directly on disk with PAST timestamps. */
async function seedFactFile(memoryDir: string, id: string, content: string): Promise<string> {
  const created = pastIso();
  const dir = path.join(memoryDir, "facts", created.slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  await writeFile(
    file,
    [
      "---",
      `id: ${id}`,
      "category: fact",
      `created: ${created}`,
      `updated: ${created}`,
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "---",
      "",
      content,
      "",
    ].join("\n"),
    "utf-8",
  );
  return file;
}

/** All markdown files under `root` (recursive); [] when the dir is absent. */
async function markdownFilesUnder(root: string): Promise<string[]> {
  try {
    const entries = (await readdir(root, { recursive: true })) as string[];
    return entries.filter((entry) => entry.endsWith(".md")).map((entry) => path.join(root, entry));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Markdown files under `root` whose body contains `needle`. */
async function memoryFilesContaining(root: string, needle: string): Promise<string[]> {
  const files = await markdownFilesUnder(root);
  const hits: string[] = [];
  for (const file of files) {
    const body = await readFile(file, "utf-8");
    if (body.includes(needle)) hits.push(file);
  }
  return hits;
}

/**
 * Remove a temp memory dir, retrying transient ENOTEMPTY/EBUSY races: the
 * orchestrator keeps best-effort background writers (last-recall impression
 * appends, catalog registration) that can still be writing while rm runs.
 */
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** Poll `probe` until it yields a truthy value (async effects settle out-of-band). */
async function eventually<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Stub the LLM extraction client at the orchestrator FIELD level (the
 * established seam — never a production hook). Records every turn slice the
 * engine is asked to extract; storage/persist stays fully real.
 */
function stubExtraction(
  orchestrator: Orchestrator,
  factory: (turns: BufferTurn[], call: number) => ExtractionResult | Promise<ExtractionResult>,
): BufferTurn[][] {
  const calls: BufferTurn[][] = [];
  (orchestrator as any).extraction = {
    extract: async (turns: BufferTurn[]) => {
      calls.push(turns);
      return factory(turns, calls.length);
    },
  };
  return calls;
}

function singleFactResult(content: string): ExtractionResult {
  return {
    facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
}

// ── 1. Recall (before_prompt_build) ──────────────────────────────────────────

test("recall() injects seeded on-disk memories into the returned context", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-recall-inject-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    await seedFactFile(
      memoryDir,
      "fact-char-inject-1",
      "The staging cluster failover runbook lives in the infra wiki under disaster drills.",
    );

    const context = await orchestrator.recall(
      "Where is the staging cluster failover runbook?",
      "session-char-inject",
    );

    // With the planner disabled and QMD off, the deterministic filesystem
    // scan serves recall and emits its "## Recent Memories" section.
    assert.match(context, /## Recent Memories/);
    assert.match(context, /staging cluster failover runbook/i);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

for (const { recallPlannerEnabled, label } of [
  { recallPlannerEnabled: true, label: "planner-on" },
  { recallPlannerEnabled: false, label: "planner-off" },
]) {
test(`recall() short-circuits no_recall intent without touching storage (${label})`, async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-no-recall-"));
  // Issue #1547 — the no_recall short-circuit must fire IDENTICALLY regardless
  // of `recallPlannerEnabled` (CLAUDE.md rule 39: feature gates identical
  // across parallel paths). Pin BOTH configurations so a future regression
  // that re-gates the short-circuit to the planner path trips here.
  const orchestrator = new Orchestrator(makeConfig(memoryDir, { recallPlannerEnabled }));
  try {
    // The public recall() surface swallows errors into "", so the pinned
    // discriminator is the storage-router probe: a no_recall prompt must
    // return BEFORE any storage resolution happens. (Extends the
    // recallInternal-level pin in tests/recall-no-recall-short-circuit.test.ts
    // up to the public entry point.)
    let storageRouterTouched = false;
    let storageForCalls = 0;
    (orchestrator as unknown as { storageRouter: unknown }).storageRouter = {
      storageFor: async () => {
        storageRouterTouched = true;
        storageForCalls += 1;
        throw new Error("storageFor must not run for no_recall prompts");
      },
    };

    const context = await orchestrator.recall("ok", `session-char-no-recall-${label}`);

    assert.equal(context, "");
    assert.equal(storageRouterTouched, false);
    assert.equal(storageForCalls, 0, "storageRouter.storageFor must not be called on the no_recall short-circuit");
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});
}

test("recall() populates the LastRecallSnapshot observable via getLastRecall()", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-last-recall-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    await seedFactFile(
      memoryDir,
      "fact-char-snapshot-1",
      "Release captains rotate the pager schedule during freeze windows.",
    );

    const prompt = "Who rotates the pager schedule during freeze windows?";
    const sessionKey = "session-char-snapshot";
    const context = await orchestrator.recall(prompt, sessionKey);
    assert.match(context, /pager schedule/i);

    // `lastRecall.record()` is deliberately non-blocking on the recall
    // response path (pinned by tests/recall-no-recall-short-circuit.test.ts),
    // so poll the public getter instead of assuming synchronous visibility.
    const snapshot = await eventually(
      async () => orchestrator.getLastRecall(sessionKey),
      "LastRecallSnapshot for the recall session",
    );
    assert.equal(snapshot.sessionKey, sessionKey);
    assert.equal(snapshot.queryLen, prompt.length);
    assert.ok(
      snapshot.memoryIds.includes("fact-char-snapshot-1"),
      `snapshot.memoryIds must contain the injected memory id (got ${JSON.stringify(snapshot.memoryIds)})`,
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("namespace-scoped writes and recall stay within the session principal's namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-namespace-"));
  const cfg = makeConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [
      { match: "alice:", principal: "alice" },
      { match: "bob:", principal: "bob" },
    ],
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      { name: "bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
    ],
  });
  const orchestrator = new Orchestrator(cfg);
  try {
    stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" ")),
    );

    // "Please remember" is a built-in high-signal pattern: smart trigger mode
    // promotes each of these turns straight to extract_now.
    await orchestrator.processTurn(
      "user",
      "Please remember: alice uses the teal dashboard theme for staging telemetry.",
      "alice:chat",
    );
    await orchestrator.processTurn(
      "user",
      "Please remember: bob files quarterly billing reconciliation in the ledger spreadsheet.",
      "bob:chat",
    );
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);

    // Storage effect: each principal's fact lands under its OWN namespace root
    // (never the default root, never the peer's root).
    const aliceRoot = await resolveNamespaceStorageRoot(cfg, "alice");
    const bobRoot = await resolveNamespaceStorageRoot(cfg, "bob");
    assert.equal((await memoryFilesContaining(aliceRoot, "teal dashboard theme")).length, 1);
    assert.equal((await memoryFilesContaining(bobRoot, "ledger spreadsheet")).length, 1);
    assert.equal((await memoryFilesContaining(aliceRoot, "ledger spreadsheet")).length, 0);
    assert.equal((await memoryFilesContaining(bobRoot, "teal dashboard theme")).length, 0);
    assert.equal(
      (await markdownFilesUnder(path.join(memoryDir, "facts"))).length,
      0,
      "namespace-routed extractions must not write to the default root facts dir",
    );

    // Recall effect: each principal only sees its own namespace's memories.
    const aliceContext = await orchestrator.recall(
      "Which dashboard theme is used for staging telemetry?",
      "alice:chat",
    );
    assert.match(aliceContext, /teal dashboard theme/i);
    assert.doesNotMatch(aliceContext, /ledger spreadsheet/i);

    const bobContext = await orchestrator.recall(
      "Where does the quarterly billing reconciliation ledger live?",
      "bob:chat",
    );
    assert.match(bobContext, /ledger spreadsheet/i);
    assert.doesNotMatch(bobContext, /teal dashboard theme/i);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

// ── 2. Buffer (agent_end) ───────────────────────────────────────────────────

test("processTurn buffers low-signal turns; a later flush drains exactly the buffered turns", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-buffer-accumulate-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );

    const sessionKey = "session-char-accumulate";
    await orchestrator.processTurn("user", "The deploy train departs at nine on Tuesdays.", sessionKey);
    await orchestrator.processTurn("assistant", "Noted the Tuesday deploy train departure.", sessionKey);
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);
    assert.equal(calls.length, 0, "low-signal turns must keep buffering, not extract");
    assert.equal(
      (await markdownFilesUnder(path.join(memoryDir, "facts"))).length,
      0,
      "no memory files may exist before the flush",
    );

    await orchestrator.flushSession(sessionKey, { reason: "before_reset" });

    assert.equal(calls.length, 1, "the flush queues exactly one extraction for the session");
    assert.deepEqual(
      calls[0]?.map((turn) => turn.content),
      [
        "The deploy train departs at nine on Tuesdays.",
        "Noted the Tuesday deploy train departure.",
      ],
      "the flush must drain the buffered turns in arrival order",
    );
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "deploy train departs")).length,
      1,
      "the flushed extraction persists to storage",
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("processTurn triggers extraction on high-signal content without an explicit flush", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-buffer-signal-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, () =>
      singleFactResult("The canary rollout gate requires two green smoke runs."),
    );

    await orchestrator.processTurn(
      "user",
      "Please remember: the canary rollout gate requires two green smoke runs.",
      "session-char-signal",
    );
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);

    assert.equal(calls.length, 1, "a high-signal turn promotes the buffer straight to extraction");
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "canary rollout gate")).length,
      1,
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("buffers are keyed by session: flushing one session leaves the other intact", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-buffer-keyed-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );

    await orchestrator.processTurn("user", "The metrics exporter batches spans every thirty seconds.", "session-char-a");
    await orchestrator.processTurn("user", "The audit sink rotates its log file at midnight UTC.", "session-char-b");

    await orchestrator.flushSession("session-char-a", { reason: "before_reset" });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]?.map((turn) => turn.content),
      ["The metrics exporter batches spans every thirty seconds."],
      "flushing session A must extract only session A's turns",
    );

    // Session B's buffer survives A's flush and drains independently.
    await orchestrator.flushSession("session-char-b", { reason: "before_reset" });
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1]?.map((turn) => turn.content),
      ["The audit sink rotates its log file at midnight UTC."],
    );

    const factsRoot = path.join(memoryDir, "facts");
    assert.equal((await memoryFilesContaining(factsRoot, "metrics exporter")).length, 1);
    assert.equal((await memoryFilesContaining(factsRoot, "audit sink")).length, 1);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

// ── 3. Extract (flush) ──────────────────────────────────────────────────────

test("extraction routes each category into its own category dir via CATEGORY_DIR_MAP", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-category-dirs-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    stubExtraction(orchestrator, () => ({
      facts: [
        { category: "fact", content: "The ingestion worker retries webhooks three times.", confidence: 0.9, tags: [] },
        { category: "decision", content: "We chose blue-green deploys for the ingestion worker.", confidence: 0.9, tags: [] },
      ],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }) as ExtractionResult);

    await orchestrator.processTurn(
      "user",
      "The ingestion worker retries webhooks three times before parking them.",
      "session-char-categories",
    );
    await orchestrator.flushSession("session-char-categories", { reason: "session-command" });

    // CORRECTED behavior (issue #1546): the extraction persist path routes each
    // category through the shared getCategoryDir()/CATEGORY_DIR_MAP chokepoint,
    // so a `fact` lands under facts/ and a `decision` lands under decisions/ —
    // no longer collapsing every category into facts/. The category still
    // survives in the id prefix and the `category:` frontmatter field.
    const factHits = await memoryFilesContaining(path.join(memoryDir, "facts"), "retries webhooks");
    assert.equal(factHits.length, 1, "category 'fact' persists under facts/");

    // The decision no longer appears under facts/ — it is routed to decisions/.
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "blue-green deploys")).length,
      0,
      "category 'decision' no longer lands under facts/",
    );

    const decisionHits = await memoryFilesContaining(path.join(memoryDir, "decisions"), "blue-green deploys");
    assert.equal(decisionHits.length, 1, "category 'decision' persists under decisions/");
    assert.match(path.basename(decisionHits[0] ?? ""), /^decision-/);
    assert.match(await readFile(decisionHits[0] ?? "", "utf-8"), /category: decision/);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("namespace-routed extraction writes advance the catalog lastWriteAt", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-catalog-touch-"));
  const cfg = makeConfig(memoryDir, {
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "alice:", principal: "alice" }],
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  });
  const orchestrator = new Orchestrator(cfg);
  try {
    stubExtraction(orchestrator, () =>
      singleFactResult("Alice pinned the flaky spec quarantine list to the team wiki."),
    );

    await orchestrator.processTurn(
      "user",
      "Please remember: alice pinned the flaky spec quarantine list to the team wiki.",
      "alice:chat",
    );
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);

    // The catalog write touch is best-effort/async relative to persist
    // (coordinates with #1522's write-recording chokepoint) — poll it.
    const record = await eventually(
      async () => {
        const candidate = await (orchestrator as any).namespaceCatalog.getNamespaceRecord("alice");
        return candidate?.lastWriteAt ? candidate : null;
      },
      "catalog lastWriteAt touch for namespace 'alice'",
    );
    assert.ok(
      Number.isFinite(Date.parse(record.lastWriteAt)),
      `lastWriteAt must be a parseable timestamp (got ${String(record.lastWriteAt)})`,
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("duplicate buffered content is dedupe-suppressed until a force-flush bypasses it (rule 29)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-dedupe-"));
  const orchestrator = new Orchestrator(
    makeConfig(memoryDir, { extractionDedupeEnabled: true, extractionDedupeWindowMs: 60_000 }),
  );
  try {
    const calls = stubExtraction(orchestrator, (_turns, call) =>
      singleFactResult(`Extraction pass ${call}: the canary gate requires two green smoke runs.`),
    );
    const highSignalContent = "Please remember: the canary gate requires two green smoke runs.";
    const sessionKey = "session-char-dedupe";

    // Pass 1: high-signal turn extracts and persists.
    await orchestrator.processTurn("user", highSignalContent, sessionKey);
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);
    assert.equal(calls.length, 1);

    // Pass 2: an IDENTICAL turn re-triggers, but the recent-fingerprint dedupe
    // suppresses the queued extraction inside the window.
    await orchestrator.processTurn("user", highSignalContent, sessionKey);
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);
    assert.equal(calls.length, 1, "the duplicate turn set must be dedupe-suppressed");

    // Force flush: flushSession passes skipDedupeCheck (rule 29), so the very
    // same suppressed buffer content extracts after all.
    await orchestrator.flushSession(sessionKey, { reason: "before_reset" });
    assert.equal(calls.length, 2, "the force-flush surface must bypass the dedupe fingerprint");

    const factsRoot = path.join(memoryDir, "facts");
    assert.equal((await memoryFilesContaining(factsRoot, "Extraction pass 1")).length, 1);
    assert.equal((await memoryFilesContaining(factsRoot, "Extraction pass 2")).length, 1);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("a failed extraction preserves the buffer and a forced retry persists it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-failed-retry-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, (_turns, call) => {
      if (call === 1) throw new Error("stubbed extraction outage");
      return singleFactResult("The replay ledger checkpoint compacts after five hundred entries.");
    });
    const sessionKey = "session-char-retry";

    await orchestrator.processTurn(
      "user",
      "Please remember: the replay ledger checkpoint compacts after five hundred entries.",
      sessionKey,
    );
    assert.equal(await orchestrator.waitForExtractionIdle(15_000), true);
    assert.equal(calls.length, 1, "the first extraction attempt ran and failed");
    assert.equal(
      (await markdownFilesUnder(path.join(memoryDir, "facts"))).length,
      0,
      "a failed extraction must not persist anything",
    );

    // The failure must not poison retries: the buffer still holds the turns
    // and the force-flush bypasses the fingerprint committed by attempt 1.
    await orchestrator.flushSession(sessionKey, { reason: "before_reset" });
    assert.equal(calls.length, 2, "the forced retry re-runs extraction over the preserved buffer");
    assert.deepEqual(
      calls[1]?.map((turn) => turn.content),
      ["Please remember: the replay ledger checkpoint compacts after five hundred entries."],
    );
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "replay ledger checkpoint")).length,
      1,
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

// ── 4. Lifecycle edges ──────────────────────────────────────────────────────

test("flushing an empty buffer is a no-op with no phantom writes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-empty-flush-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, () => {
      throw new Error("an empty flush must never reach the extraction client");
    });

    await orchestrator.flushSession("session-char-empty", { reason: "before_reset" });

    assert.equal(calls.length, 0);
    assert.equal((await markdownFilesUnder(path.join(memoryDir, "facts"))).length, 0);
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("session_end flush force-persists the session's buffered turns", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-session-end-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    const calls = stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    const sessionKey = "session-char-end";

    await orchestrator.processTurn("user", "The nightly compaction sweep runs after the backup snapshot.", sessionKey);
    await orchestrator.flushSession(sessionKey, { reason: "session_end" });

    assert.equal(calls.length, 1);
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "nightly compaction sweep")).length,
      1,
    );
  } finally {
    await orchestrator.destroy();
    await cleanupDir(memoryDir);
  }
});

test("restart recovery: a fresh orchestrator over the same memoryDir sees prior state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-restart-"));
  const first = new Orchestrator(makeConfig(memoryDir));
  let second: Orchestrator | null = null;
  try {
    stubExtraction(first, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );

    // Instance 1 persists one memory (flushed) and PARKS a second session's
    // turn in the buffer without flushing it.
    await first.processTurn("user", "The failover drill rehearses the read-replica promotion path.", "session-char-flushed");
    await first.flushSession("session-char-flushed", { reason: "before_reset" });
    await first.processTurn("user", "The quota reconciler defers negative balances to manual review.", "session-char-parked");
    await first.destroy();

    // Instance 2: brand-new orchestrator, same memoryDir, fresh config parse.
    second = new Orchestrator(makeConfig(memoryDir));
    const secondCalls = stubExtraction(second, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );

    // (a) Previously persisted memories are recallable by the new instance —
    // no stale per-instance cache can hide cross-restart storage state.
    const context = await second.recall(
      "How does the failover drill handle read-replica promotion?",
      "session-char-restart-reader",
    );
    assert.match(context, /read-replica promotion/i);

    // (b) The parked buffer survived the restart (state/buffer.json) and a
    // flush on the NEW instance drains it.
    await second.flushSession("session-char-parked", { reason: "session_end" });
    assert.equal(secondCalls.length, 1, "the new instance flushes the buffer parked before restart");
    assert.deepEqual(
      secondCalls[0]?.map((turn) => turn.content),
      ["The quota reconciler defers negative balances to manual review."],
    );
    assert.equal(
      (await memoryFilesContaining(path.join(memoryDir, "facts"), "quota reconciler")).length,
      1,
    );
  } finally {
    if (second) await second.destroy();
    await cleanupDir(memoryDir);
  }
});

// ── 5. Maintenance ──────────────────────────────────────────────────────────

// Root-suite pin of the #1506 r27 contract (now exercised directly against
// MaintenanceScheduler, which owns runQmdMaintenance after the #1526 PR1
// extraction): runQmdMaintenance must cover the UNION of configured namespaces
// and cataloged dynamic namespaces, batched into one strict router update.
test("runQmdMaintenance unions configured and cataloged namespaces into one strict update", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-char-qmd-union-"));
  let scheduler: MaintenanceScheduler | undefined;
  try {
    // Fixture: partial config cast — only the fields the scheduler/planner
    // read are populated; qmdMaintenanceEnabled + a long debounce arm the
    // debounced pending flag via the public requestQmdMaintenanceForTool path.
    const config = {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      maintenanceNamespaceLockStaleMs: 100,
      qmdAutoEmbedEnabled: true,
      qmdEmbedMinIntervalMs: 0,
      qmdMaintenanceEnabled: true,
      qmdMaintenanceDebounceMs: 60_000,
    } as unknown as PluginConfig;

    // A dynamic namespace that exists ONLY in the catalog (never configured),
    // with a live storage root so the planner's safety check accepts it.
    const dynamicNamespace = "project-char-dynamic";
    const dynamicStorageDir = await resolveNamespaceStorageRoot(
      config,
      dynamicNamespace,
    );
    await mkdir(path.join(dynamicStorageDir, "facts"), { recursive: true });

    // Fixture: catalog stub implements only listNamespaces + markMaintenance.
    const catalog = {
      enabled: true,
      async listNamespaces() {
        return [
          { namespace: "default" },
          {
            namespace: dynamicNamespace,
            identityToken: path.basename(dynamicStorageDir),
            kind: "project",
            createdAt: pastIso(),
            storageDir: dynamicStorageDir,
            discoveredBy: "write",
          },
        ];
      },
      async markMaintenance() {},
    };

    const updateCalls: Array<{ namespaces: string[]; strict: boolean | undefined }> = [];
    const embedCalls: Array<{ namespaces: string[]; strict: boolean | undefined }> = [];
    // Fixture: router stub implements only the two methods runQmdMaintenance invokes.
    const router = {
      async updateNamespacesDetailed(
        namespaces: string[],
        _execution: unknown,
        options: { strict?: boolean } | undefined,
      ): Promise<{ backendCount: number; eligibleNamespaces: string[] }> {
        updateCalls.push({ namespaces: [...namespaces], strict: options?.strict });
        return { backendCount: namespaces.length, eligibleNamespaces: namespaces };
      },
      // Mock signature matches production (rule 33 / #1545 codex review):
      // runQmdMaintenance passes { strict: true }, and dropping the options
      // parameter here would let a non-strict regression pass silently.
      async embedNamespaces(
        namespaces: string[],
        options: { strict?: boolean } | undefined,
      ): Promise<void> {
        embedCalls.push({ namespaces: [...namespaces], strict: options?.strict });
      },
    };

    scheduler = new MaintenanceScheduler({
      config,
      // Fixture: live accessor — only isAvailable() is checked when arming
      // pending. Mirrors the production wiring (getQmd: () => this.qmd).
      getQmd: () => ({ isAvailable: () => true }),
      namespaceSearchRouter: router,
      namespaceCatalog: catalog,
      // Fixture cast: stubs implement only the surface runQmdMaintenance invokes.
    } as unknown as ConstructorParameters<typeof MaintenanceScheduler>[0]);
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    assert.equal(updateCalls.length, 1, "maintenance batches the selected namespaces into ONE update");
    assert.equal(updateCalls[0]?.strict, true, "recurring maintenance uses strict update semantics");
    assert.deepEqual(
      new Set(updateCalls[0]?.namespaces),
      new Set(["default", "shared", dynamicNamespace]),
      "the update set is the UNION of configured + cataloged namespaces",
    );
    assert.equal(embedCalls.length, 1, "auto-embed batches the same selection into one router call");
    assert.equal(embedCalls[0]?.strict, true, "recurring maintenance uses strict embed semantics");
    assert.deepEqual(
      new Set(embedCalls[0]?.namespaces),
      new Set(["default", "shared", dynamicNamespace]),
    );
  } finally {
    await scheduler?.dispose();
    await cleanupDir(memoryDir);
  }
});
