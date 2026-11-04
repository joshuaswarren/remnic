// Server behavioral test: booting the daemon starts the backlog scheduler and
// a session persisted BEFORE startup drains automatically through the real
// pipeline (claim → extraction → durable memory), with no external worker.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BufferSessionFiles } from "@remnic/core/storage/buffer-session-files.js";
import { startServer, type ServerResult } from "./index.js";

/** The established extraction field seam (identical to core's test helper). */
interface ExtractionClientSeam {
  extraction: { extract: (turns: unknown[]) => Promise<unknown> };
}

function stubExtraction(orchestrator: { extraction: unknown }, factory: (turns: { content: string }[]) => unknown): { calls: { content: string }[][] } {
  const calls: { content: string }[][] = [];
  const seam = orchestrator as ExtractionClientSeam;
  // SAFETY: the field-level seam is the established test pattern; the
  // orchestrator owns the shape.
  seam.extraction = {
    extract: async (turns: { content: string }[]) => {
      calls.push(turns);
      return { memories: [{ content: `fact for ${turns[0]?.content ?? "empty"}`, entities: [], topics: [] }], meta: {} };
    },
  };
  return { calls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  // Real daemon timer path (the scheduler's poll interval) — a genuine wait
  // against the platform clock is the only honest signal here.
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}

test("a booted daemon drains pre-existing backlog without any external worker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-backlog-server-"));
  const memoryDir = path.join(dir, "memory");
  const configPath = path.join(dir, "remnic.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        openaiApiKey: "sk-test",
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
      },
      server: { host: "127.0.0.1", authToken: "test-token" },
    }),
    "utf8",
  );

  // Persisted backlog BEFORE startup: the session file the daemon must claim
  // and drain on its own.
  const files = new BufferSessionFiles(memoryDir, {
    read: async (p) => readFile(p, "utf8"),
    write: async (p, content) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content);
    },
  });
  await files.save("seeded", {
    turns: [{ role: "user", content: "the seeded backlog fact about teal dashboards", timestamp: "2026-11-01T00:00:00.000Z", sessionKey: "seeded" }],
    lastExtractionAt: null,
    extractionCount: 0,
  });

  let result: ServerResult | undefined;
  try {
    result = await startServer({ configPath, authToken: "test-token", allowEphemeralPort: true });
    const { calls } = stubExtraction(result.orchestrator, () => null);
    // A durable fact file appearing under the memory root (any namespace).
    let factSeen = false;
    const poller = (async () => {
      for (let attempt = 0; attempt < 240 && !factSeen; attempt += 1) {
        factSeen = await hasFactFile(memoryDir);
        if (!factSeen) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const drained = await waitFor(() => calls.length > 0, 60_000);
    assert.equal(drained, true, "the scheduler extracted the seeded claim");
    assert.deepEqual(
      calls[0]?.map((t) => t.content),
      ["the seeded backlog fact about teal dashboards"],
    );
    await poller;
    assert.equal(factSeen, true, "a durable memory exists after the drain");
    const claims = result.orchestrator.storage.bufferDrainClaims();
    const listed = await claims.list();
    assert.ok(listed.every((l) => l.turnCount === 0), "the claim is an empty tombstone");
  } finally {
    await result?.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

async function hasFactFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasFactFile(child)) return true;
    } else if (entry.name.endsWith(".md") && (await readFile(child, "utf8").then((c) => c.includes("fact for"), () => false))) {
      return true;
    }
  }
  return false;
}
