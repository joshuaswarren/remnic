// Server behavioral test: a REAL loopback OpenAI-compatible model boundary is
// up BEFORE daemon boot; persisted backlog (seeded through the real public
// Orchestrator buffer API before startServer) is claimed, extracted by the
// REAL engine/renderer/queue, and durably written — no extraction seam swap,
// no fake result shapes. The boundary records every chat completion body so
// the ACTUAL prompt is asserted, not a stub's bookkeeping.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Orchestrator, parseConfig } from "@remnic/core";
import { type ServerResult, startServer } from "./index.js";

const FACT = "I prefer teal dashboards for my workspace.";
// Exact house ExtractionResult shape (singleFactResult): category "fact",
// tags array, relationships — the engine's parser + persistence expect it.
const EXTRACTION_JSON = JSON.stringify({
  facts: [{ category: "fact", content: FACT, confidence: 0.9, tags: [], quote: FACT }],
  entities: [],
  relationships: [],
  questions: [],
  profileUpdates: [],
});

/** Loopback OpenAI-compatible boundary: records every completion body. */
async function startModelBoundary(): Promise<{
  url: string;
  bodies: string[];
  sawMarker(marker: string): boolean;
  close(): Promise<void>;
}> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST") bodies.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: EXTRACTION_JSON } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address instanceof Object ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    sawMarker: (marker: string) => bodies.some((body) => body.includes(marker)),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 45_000): Promise<boolean> {
  // Waits on the daemon's real poll interval + real pipeline — platform clock.
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return await predicate();
}

async function hasFactFile(dir: string, needle: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasFactFile(child, needle)) return true;
    } else if (
      entry.name.endsWith(".md") &&
      (await readFile(child, "utf8").then(
        (c) => c.includes(needle),
        () => false
      ))
    ) {
      return true;
    }
  }
  return false;
}

test("a booted daemon drains persisted backlog through the real pipeline (actual prompt, durable fact, empty claim)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-backlog-server-"));
  const memoryDir = path.join(dir, "memory");
  const model = await startModelBoundary();
  const remnic = {
    memoryDir,
    openaiApiKey: "sk-test",
    openaiBaseUrl: model.url,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    localLlmEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    compoundingEnabled: false,
    knowledgeIndexEnabled: false,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
  };
  const configPath = path.join(dir, "remnic.json");
  await writeFile(
    configPath,
    JSON.stringify({ remnic, server: { host: "127.0.0.1", authToken: "test-token" } }),
    "utf8"
  );

  // Seed BEFORE boot through the real public buffer API (native persistence).
  const seeder = new Orchestrator(parseConfig(remnic));
  try {
    await seeder.buffer.addTurn("seeded", {
      role: "user",
      content: FACT,
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "seeded",
    });
    await seeder.buffer.save();
  } finally {
    await seeder.destroy().catch(() => undefined);
  }

  let result: ServerResult | undefined;
  try {
    result = await startServer({ configPath, authToken: "test-token", allowEphemeralPort: true });
    const promptSeen = await waitFor(() => model.sawMarker(FACT), 45_000);
    assert.equal(promptSeen, true, "the ACTUAL chat prompt contains the seeded marker");
    const factSeen = await waitFor(() => hasFactFile(memoryDir, FACT), 45_000);
    assert.ok(factSeen, "a grounded fact file was durably written");
    const scheduler = result.backlogScheduler;
    const counted = await waitFor(() => scheduler.snapshot().counters.processed >= 1);
    assert.ok(counted, "the scheduler counted real progress");
    const drainDir = path.join(memoryDir, "state", "buffer", "drain");
    const names = (await readdir(drainDir)).filter((n) => n.endsWith(".json") && !n.endsWith(".lease.json"));
    assert.ok(names.length >= 1, "a claim file exists");
    for (const name of names) {
      // SAFETY: the claim file is this test"s own JSON tombstone; only the
      // drained-turn count is read.
      const body = JSON.parse(await readFile(path.join(drainDir, name), "utf8")) as { entry?: { turns?: string[] } };
      assert.equal(body.entry?.turns?.length ?? 0, 0, `claim ${name} ended as an empty tombstone`);
    }
  } finally {
    await result?.stop().catch(() => {});
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
});
