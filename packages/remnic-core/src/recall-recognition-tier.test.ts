/**
 * recall-recognition-tier.test.ts — issue #2975 foundation slice.
 *
 * Pins the full-index recognition tier contract:
 *  - under-threshold namespaces recall by recognizing against the FULL
 *    compact index (every id+description line reaches the recognizer) and
 *    never touch vector search;
 *  - above-threshold namespaces route to vector search and never call the
 *    recognizer;
 *  - a missing (or unreadable) index falls back to vector search cleanly,
 *    without throwing;
 *  - the tier decision is deterministic and pure on (index, maxEntries);
 *  - recognizer picks are validated against the index and returned in
 *    index order, never recognizer order;
 *  - a failing recognizer degrades LOUDLY to vector search, labeled.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  buildRecognitionIndex,
  buildRecognitionPrompt,
  decideRecognitionTier,
  loadRecognitionIndex,
  parseRecognizerIds,
  parseRecallRecognitionTier,
  parseRecognitionIndexMaxEntries,
  recallViaRecognitionTier,
  recognitionIndexPath,
  renderRecognitionIndex,
  runRecognitionTier,
  saveRecognitionIndex,
  type RecognitionIndex,
  type RecognitionIndexEntry,
} from "./recall-recognition-tier.js";

function entries(n: number): RecognitionIndexEntry[] {
  const out: RecognitionIndexEntry[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: `m-${String(i).padStart(3, "0")}`,
      description: `Recognition trigger line ${i} for namespace fixture ${i}.`,
    });
  }
  return out;
}

async function tmpNamespace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-recognition-"));
}

test("decideRecognitionTier: deterministic decision table", () => {
  const absent = decideRecognitionTier(null, { maxEntries: 10 });
  assert.equal(absent.tier, "vector");
  assert.equal(absent.reason, "index_absent");
  assert.equal(absent.entriesConsidered, 0);

  const within = decideRecognitionTier(
    { version: 1, entries: entries(3) },
    { maxEntries: 10 },
  );
  assert.equal(within.tier, "recognition");
  assert.equal(within.reason, "index_within_threshold");
  assert.equal(within.entriesConsidered, 3);

  const atThreshold = decideRecognitionTier(
    { version: 1, entries: entries(4) },
    { maxEntries: 4 },
  );
  assert.equal(atThreshold.tier, "recognition");

  const above = decideRecognitionTier(
    { version: 1, entries: entries(5) },
    { maxEntries: 4 },
  );
  assert.equal(above.tier, "vector");
  assert.equal(above.reason, "index_above_threshold");
  assert.equal(above.entriesConsidered, 5);

  const empty = decideRecognitionTier({ version: 1, entries: [] }, { maxEntries: 10 });
  assert.equal(empty.tier, "recognition");
  assert.equal(empty.reason, "index_within_threshold");
});

test("loadRecognitionIndex: missing, corrupt, wrong-shape, and future-version indexes return null without throwing", async () => {
  const dir = await tmpNamespace();
  try {
    // Missing file.
    assert.equal(await loadRecognitionIndex(dir), null);

    // Corrupt JSON.
    const file = recognitionIndexPath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    assert.equal(await loadRecognitionIndex(dir), null);

    // Valid JSON, wrong shape.
    await writeFile(file, JSON.stringify({ version: 1, entries: "nope" }), "utf8");
    assert.equal(await loadRecognitionIndex(dir), null);

    // Future schema version.
    await writeFile(
      file,
      JSON.stringify({ version: 99, entries: entries(2) }),
      "utf8",
    );
    assert.equal(await loadRecognitionIndex(dir), null);

    // Roundtrip: save then load returns the same index.
    const index: RecognitionIndex = { version: 1, entries: entries(2) };
    await saveRecognitionIndex(dir, index);
    assert.deepEqual(await loadRecognitionIndex(dir), index);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRecognitionIndex: drops blank ids, trims descriptions, first id wins", () => {
  const built = buildRecognitionIndex([
    { id: "m-001", description: "  first line  " },
    { id: "", description: "blank id is dropped" },
    { id: "   ", description: "whitespace id is dropped" },
    { id: "m-001", description: "duplicate id keeps the first description" },
    { id: "m-002", description: "second line" },
  ]);
  assert.deepEqual(built.entries, [
    { id: "m-001", description: "first line" },
    { id: "m-002", description: "second line" },
  ]);
  assert.equal(built.version, 1);
});

test("acceptance: under-threshold namespace uses the full-index path, not vector search", async () => {
  const dir = await tmpNamespace();
  try {
    const index: RecognitionIndex = { version: 1, entries: entries(3) };
    await saveRecognitionIndex(dir, index);

    const prompts: string[] = [];
    const outcome = await recallViaRecognitionTier({
      memoryDir: dir,
      query: "which memories bear on the question?",
      maxEntries: 10,
      recognize: async (prompt) => {
        prompts.push(prompt);
        return "m-002, m-003";
      },
      vectorSearch: async () => {
        throw new Error("vector search must not run on the recognition tier");
      },
    });

    assert.equal(outcome.decision.tier, "recognition");
    assert.equal(outcome.decision.reason, "index_within_threshold");
    assert.deepEqual(outcome.ids, ["m-002", "m-003"]);
    assert.deepEqual(outcome.vectorResults, []);
    assert.equal(outcome.degraded, undefined);

    // Full-index proof: the recognizer saw EVERY index line.
    assert.equal(prompts.length, 1);
    for (const entry of index.entries) {
      assert.ok(prompts[0].includes(`${entry.id}: ${entry.description}`), `prompt must carry ${entry.id}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance: above-threshold namespace uses vector search, not the recognizer", async () => {
  const dir = await tmpNamespace();
  try {
    await saveRecognitionIndex(dir, { version: 1, entries: entries(5) });

    const outcome = await recallViaRecognitionTier({
      memoryDir: dir,
      query: "anything",
      maxEntries: 4,
      recognize: async () => {
        throw new Error("recognizer must not run on the vector tier");
      },
      vectorSearch: async () => ["vec-hit-1", "vec-hit-2"],
    });

    assert.equal(outcome.decision.tier, "vector");
    assert.equal(outcome.decision.reason, "index_above_threshold");
    assert.deepEqual(outcome.ids, []);
    assert.deepEqual(outcome.vectorResults, ["vec-hit-1", "vec-hit-2"]);
    assert.equal(outcome.degraded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance: missing index falls back to vector search cleanly, without error", async () => {
  const dir = await tmpNamespace();
  try {
    const outcome = await recallViaRecognitionTier({
      memoryDir: dir,
      query: "anything",
      maxEntries: 10,
      recognize: async () => {
        throw new Error("recognizer must not run without an index");
      },
      vectorSearch: async () => ["vec-fallback"],
    });

    assert.equal(outcome.decision.tier, "vector");
    assert.equal(outcome.decision.reason, "index_absent");
    assert.deepEqual(outcome.ids, []);
    assert.deepEqual(outcome.vectorResults, ["vec-fallback"]);
    assert.equal(outcome.degraded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loud degradation: a failing recognizer falls back to vector search, labeled", async () => {
  const dir = await tmpNamespace();
  try {
    await saveRecognitionIndex(dir, { version: 1, entries: entries(2) });

    const outcome = await recallViaRecognitionTier({
      memoryDir: dir,
      query: "anything",
      maxEntries: 10,
      recognize: async () => {
        throw new Error("model down");
      },
      vectorSearch: async () => ["vec-degraded"],
    });

    assert.equal(outcome.decision.tier, "recognition");
    assert.equal(outcome.degraded, "recognizer_unavailable");
    assert.deepEqual(outcome.ids, []);
    assert.deepEqual(outcome.vectorResults, ["vec-degraded"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRecognitionTier: empty index short-circuits with no model call", async () => {
  let calls = 0;
  const run = await runRecognitionTier("q", [], async () => {
    calls++;
    return "m-001";
  });
  assert.equal(calls, 0);
  assert.equal(run.skipped, true);
  assert.deepEqual(run.ids, []);
});

test("runRecognitionTier: unknown ids are dropped; output is index order, not recognizer order", async () => {
  const idx = entries(4);
  const run = await runRecognitionTier("q", idx, async () =>
    "m-004, hallucinated-id, m-001, m-004",
  );
  assert.deepEqual(run.ids, ["m-001", "m-004"]);
  assert.deepEqual(run.dropped, ["hallucinated-id"]);
});

test("runRecognitionTier and prompt are byte-identical across runs with unchanged inputs", async () => {
  const idx = entries(5);
  const recognizer = async () => "m-003, m-001";
  const first = await runRecognitionTier("same query", idx, recognizer);
  const second = await runRecognitionTier("same query", idx, recognizer);
  assert.deepEqual(first, second);
  assert.equal(
    buildRecognitionPrompt("same query", idx),
    buildRecognitionPrompt("same query", idx),
  );
  assert.equal(renderRecognitionIndex(idx).split("\n").length, 5);
});

test("parseRecognizerIds: tolerant parsing of JSON arrays, lists, and noise", () => {
  assert.deepEqual(parseRecognizerIds('["m-001","m-002"]'), ["m-001", "m-002"]);
  assert.deepEqual(parseRecognizerIds("m-001, m-002"), ["m-001", "m-002"]);
  assert.deepEqual(parseRecognizerIds("m-001\nm-002."), ["m-001", "m-002"]);
  assert.deepEqual(parseRecognizerIds("m-001, m-001, m-002"), ["m-001", "m-002"]);
  assert.deepEqual(parseRecognizerIds(null), []);
  assert.deepEqual(parseRecognizerIds("   "), []);
});

test("config parse helpers: defaults, coercion, and rejection", () => {
  assert.equal(parseRecallRecognitionTier(undefined), false);
  assert.equal(parseRecallRecognitionTier(true), true);
  assert.equal(parseRecallRecognitionTier("false"), false);

  assert.equal(parseRecognitionIndexMaxEntries(undefined), 500);
  assert.equal(parseRecognitionIndexMaxEntries(128.9), 128);
  assert.throws(() => parseRecognitionIndexMaxEntries(0), /recognitionIndexMaxEntries/);
  assert.throws(() => parseRecognitionIndexMaxEntries("abc"), /recognitionIndexMaxEntries/);
});

test("parseConfig: recognition tier keys parse with byte-identical defaults", () => {
  const config = parseConfig({});
  assert.equal(config.recallRecognitionTier, false);
  assert.equal(config.recognitionIndexMaxEntries, 500);

  const optedIn = parseConfig({ recallRecognitionTier: true, recognitionIndexMaxEntries: 42 });
  assert.equal(optedIn.recallRecognitionTier, true);
  assert.equal(optedIn.recognitionIndexMaxEntries, 42);
});
