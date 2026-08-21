import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { type XConnectorConfig, parseXConnectorConfig } from "./config.js";
import { createFileSink } from "./file-sink.js";
import { getXStatus, runXSync } from "./sync.js";
import type { XMemorySink, XMemorySuggestion } from "./types.js";

function recordingSink(fail = false): XMemorySink & {
  suggestions: XMemorySuggestion[];
  stored: XMemorySuggestion[];
} {
  const sink = {
    suggestions: [] as XMemorySuggestion[],
    stored: [] as XMemorySuggestion[],
  };
  return {
    ...sink,
    async submitSuggestion(suggestion) {
      if (fail) throw new Error("queue down");
      sink.suggestions.push(suggestion);
    },
    async storeMemory(suggestion) {
      if (fail) throw new Error("store down");
      sink.stored.push(suggestion);
    },
  };
}

async function corpusWith(entries: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-sync-"));
  for (const [name, payload] of Object.entries(entries)) {
    await writeFile(path.join(dir, name), JSON.stringify(payload));
  }
  return dir;
}

function configFor(overrides: Record<string, unknown>): XConnectorConfig {
  return parseXConnectorConfig(overrides);
}

test("first sync ingests, dedupes on the second, and updates on content change", async () => {
  const corpus = await corpusWith({
    "a.json": { id: "1", text: "first bookmark", username: "k" },
    "b.json": { id: "2", text: "second bookmark" },
  });
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    sources: [{ id: "local", kind: "corpusDir", path: corpus }],
  });
  const sink = recordingSink();

  const first = await runXSync(config, { sink });
  assert.equal(first.sources[0].recordsNew, 2);
  assert.equal(first.suggestionsSubmitted, 2);
  assert.equal(first.sources[0].skipped, undefined);
  assert.deepEqual(sink.suggestions.map((entry) => entry.record.postId).sort(), ["1", "2"]);
  assert.ok(sink.suggestions.every((entry) => entry.tags.includes("x/bookmark")));

  // Record files materialized with provenance stamped.
  const recordFiles = (await readdir(path.join(stateDir, "records"))).sort();
  assert.deepEqual(recordFiles, ["1.json", "2.json"]);
  const persisted = JSON.parse(await readFile(path.join(stateDir, "records", "1.json"), "utf8")) as {
    provenance: { sourceId: string; syncRunId: string };
  };
  assert.equal(persisted.provenance.sourceId, "local");
  assert.equal(persisted.provenance.syncRunId, first.runId);

  // Second sync over the same corpus: everything known, nothing new emitted.
  const second = await runXSync(config, { sink });
  assert.equal(second.sources[0].recordsNew, 0);
  assert.equal(second.sources[0].recordsKnown, 2);
  assert.equal(second.suggestionsSubmitted, 0);

  // Same post id, edited content → re-ingested once, firstSeenAt preserved.
  await writeFile(
    path.join(corpus, "a.json"),
    JSON.stringify({ id: "1", text: "first bookmark EDITED", username: "k" })
  );
  const third = await runXSync(config, { sink });
  assert.equal(third.sources[0].recordsNew, 1);
  assert.equal(third.sources[0].recordsKnown, 1);
  const edited = JSON.parse(await readFile(path.join(stateDir, "records", "1.json"), "utf8")) as { text: string };
  assert.equal(edited.text, "first bookmark EDITED");
});

test("source priority order is honored (cheapest first)", async () => {
  const corpus = await corpusWith({ "a.json": { id: "1", text: "from corpus" } });
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    sourcePriority: ["cheap", "dear"],
    sources: [
      { id: "dear", kind: "cli" },
      { id: "cheap", kind: "corpusDir", path: corpus },
    ],
  });
  const order: string[] = [];
  const exec = async (bin: string) => {
    order.push(bin);
    return { stdout: JSON.stringify([{ id: "9", text: "from cli", kind: "own_post" }]), stderr: "" };
  };
  const report = await runXSync(config, { sink: recordingSink(), execImpl: exec });
  assert.deepEqual(
    report.sources.map((entry) => entry.sourceId),
    ["cheap", "dear"]
  );
  assert.deepEqual(order, ["bird"]);
  const kinds = report.sources.flatMap((entry) => entry.recordsNew);
  assert.deepEqual(kinds, [1, 1]);
});

test("memoryMode=store routes through storeMemory", async () => {
  const corpus = await corpusWith({ "a.json": { id: "5", text: "mine", kind: "post" } });
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    memoryMode: "store",
    sources: [{ id: "local", kind: "corpusDir", path: corpus }],
  });
  const sink = recordingSink();
  const report = await runXSync(config, { sink });
  assert.equal(report.memoryMode, "store");
  assert.equal(report.memoriesStored, 1);
  assert.equal(report.suggestionsSubmitted, 0);
  assert.equal(sink.stored[0].tags[0], "x/post");
});

test("sink failures are counted, never crash the sync", async () => {
  const corpus = await corpusWith({
    "a.json": { id: "1", text: "x" },
    "b.json": { id: "2", text: "y" },
  });
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    sources: [{ id: "local", kind: "corpusDir", path: corpus }],
  });
  const report = await runXSync(config, { sink: recordingSink(true) });
  assert.equal(report.sinkFailures, 2);
  assert.equal(report.sources[0].recordsNew, 2);
});

test("mcp spend accrues in the monthly ledger and status reports it against the cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-mcp-"));
  const tokenFile = path.join(dir, "tokens.json");
  await writeFile(
    tokenFile,
    JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000 })
  );
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    sources: [
      {
        id: "x-mcp",
        kind: "mcp",
        auth: { tokenFile },
        budget: { maxPagesPerSync: 1, maxCostUsdPerMonth: 5, costPerReadUsd: 0.01 },
      },
    ],
  });
  const responses = [
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": "s" },
    }),
    new Response("", { status: 202 }),
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ data: [{ id: "77", text: "paid read" }] }),
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ),
  ];
  const report = await runXSync(config, {
    sink: recordingSink(),
    env: { REMNIC_X_CLIENT_ID: "cid", REMNIC_X_CLIENT_SECRET: "sec" },
    fetchImpl: (async () => {
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    }) as typeof fetch,
  });
  assert.equal(report.sources[0].reads, 1);
  assert.equal(report.monthSpendUsd, 0.01);

  const status = await getXStatus(config, {
    env: { REMNIC_X_CLIENT_ID: "cid", REMNIC_X_CLIENT_SECRET: "sec" },
  });
  assert.equal(status.monthSpendUsd, 0.01);
  assert.equal(status.monthlyCostCapUsd, 5);
  assert.equal(status.seenCount, 1);
  assert.equal(status.lastSyncAt !== null, true);
  assert.equal(status.sources[0].sourceId, "x-mcp");
  assert.equal(status.sources[0].available, true);
  assert.equal(status.sources[0].lastRecordsNew, 1);
});

test("status flags a missing corpus dir and missing credentials offline", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const config = configFor({
    stateDir,
    sources: [
      { id: "c", kind: "corpusDir", path: "/nonexistent/remnic-x-corpus" },
      { id: "m", kind: "mcp" },
    ],
  });
  const status = await getXStatus(config, { env: {} });
  const corpus = status.sources.find((entry) => entry.sourceId === "c");
  const mcp = status.sources.find((entry) => entry.sourceId === "m");
  assert.ok(corpus !== undefined && mcp !== undefined);
  assert.equal(corpus.available, false);
  assert.match(corpus.availabilityDetail ?? "", /not found/);
  assert.equal(mcp.available, false);
  assert.equal(status.lastSyncAt, null);
});

test("file sink honors the trust gate by directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const corpus = await corpusWith({ "a.json": { id: "1", text: "z" } });
  const suggestConfig = configFor({
    stateDir,
    sources: [{ id: "local", kind: "corpusDir", path: corpus }],
  });
  await runXSync(suggestConfig, { sink: createFileSink({ stateDir, mode: "suggest" }) });
  const suggestFiles = await readdir(path.join(stateDir, "suggestions"));
  assert.deepEqual(suggestFiles, ["1.json"]);

  const storeState = await mkdtemp(path.join(tmpdir(), "remnic-x-state-"));
  const storeConfig = configFor({
    stateDir: storeState,
    sources: [{ id: "local", kind: "corpusDir", path: corpus }],
  });
  await runXSync(storeConfig, {
    sink: createFileSink({ stateDir: storeState, mode: "store" }),
  });
  const storeFiles = await readdir(path.join(storeState, "records"));
  assert.deepEqual(storeFiles, ["1.json"]);
});
