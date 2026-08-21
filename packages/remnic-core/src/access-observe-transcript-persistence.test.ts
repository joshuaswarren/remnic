/**
 * Issue #2783: the daemon's observe path must persist observe-derived turns
 * into the transcript store, and `memory_summarize_hourly` must report an
 * empty/stale transcript store distinctly instead of a bare unconditional
 * ok. Delegate-mode gateways (and any observe-only client) starve the
 * hourly summarizer otherwise — 11 days of silent empty runs in the field.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { HourlySummarizer } from "./summarizer.js";
import { Orchestrator } from "./orchestrator.js";
import { TranscriptManager } from "./transcript.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface StubOrchestrator {
  config: PluginConfig;
  transcript: TranscriptManager;
  summarizer: HourlySummarizer;
  lcmEngine?: undefined;
  ingestReplayBatch: () => Promise<unknown[]>;
  _codingContextBySession: Map<string, CodingContext>;
}

function makeService(
  memoryDir: string,
  transcriptEnabled: boolean
): { service: EngramAccessService; orchestrator: StubOrchestrator } {
  const config = {
    memoryDir,
    transcriptEnabled,
    transcriptSkipChannelTypes: [],
    namespacesEnabled: false,
    defaultNamespace: "default",
  } as unknown as PluginConfig;
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const stub: StubOrchestrator = {
    config,
    transcript: new TranscriptManager(config),
    summarizer: new HourlySummarizer(config),
    lcmEngine: undefined,
    ingestReplayBatch: async () => [],
    _codingContextBySession: new Map<string, CodingContext>(),
  };
  Object.assign(orch as unknown as Record<string, unknown>, stub);
  return { service: new EngramAccessService(orch), orchestrator: stub };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-2783-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAllTranscriptLines(dir: string): Promise<Array<Record<string, unknown>>> {
  const root = path.join(dir, "transcripts");
  const entries: Array<Record<string, unknown>> = [];
  const typeDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const typeEnt of typeDirs) {
    if (!typeEnt.isDirectory()) continue;
    const idDirs = await readdir(path.join(root, typeEnt.name), { withFileTypes: true });
    for (const idEnt of idDirs) {
      if (!idEnt.isDirectory()) continue;
      const files = await readdir(path.join(root, typeEnt.name, idEnt.name));
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const raw = await readFile(path.join(root, typeEnt.name, idEnt.name, file), "utf-8");
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) continue;
          entries.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    }
  }
  return entries;
}

const USER_TURN = "please summarize the replication topology for the fleet";
const ASSISTANT_TURN = "the fleet uses one primary daemon with a replicated failover copy";

test("observe persists user and assistant turns into the transcript store (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(dir, true);
    const response = await service.observe({
      sessionKey: "agent:delegate-test:session-1",
      messages: [
        { role: "user", content: USER_TURN },
        { role: "assistant", content: ASSISTANT_TURN },
      ],
    });
    assert.equal(response.transcriptPersisted, true);
    const entries = await readAllTranscriptLines(dir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.role, "user");
    assert.equal(entries[0]?.content, USER_TURN);
    assert.equal(entries[0]?.sessionKey, "agent:delegate-test:session-1");
    assert.equal(entries[1]?.role, "assistant");
    assert.equal(entries[1]?.content, ASSISTANT_TURN);
    assert.equal(typeof entries[0]?.turnId, "string");
    assert.equal(typeof entries[0]?.timestamp, "string");
  });
});

test("observe filters short messages below the embedded parity noise floor (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(dir, true);
    const response = await service.observe({
      sessionKey: "agent:delegate-test:session-2",
      messages: [
        { role: "user", content: "ok" },
        { role: "assistant", content: ASSISTANT_TURN },
      ],
    });
    assert.equal(response.transcriptPersisted, true);
    const entries = await readAllTranscriptLines(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, "assistant");
  });
});

test("a re-POST of the same user turn is deduped; new turns still append (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(dir, true);
    await service.observe({
      sessionKey: "agent:delegate-test:session-3",
      messages: [
        { role: "user", content: USER_TURN },
        { role: "assistant", content: ASSISTANT_TURN },
      ],
    });
    // Un-keyed client retry of the SAME turn (no idempotencyKey).
    await service.observe({
      sessionKey: "agent:delegate-test:session-3",
      messages: [
        { role: "user", content: USER_TURN },
        { role: "assistant", content: ASSISTANT_TURN },
      ],
    });
    const afterRetry = await readAllTranscriptLines(dir);
    assert.equal(afterRetry.length, 2);

    // A genuinely new turn still appends.
    await service.observe({
      sessionKey: "agent:delegate-test:session-3",
      messages: [{ role: "user", content: "now check the failover read path end to end please" }],
    });
    const afterNew = await readAllTranscriptLines(dir);
    assert.equal(afterNew.length, 3);
  });
});

test("transcript persistence is gated on the transcriptEnabled capability (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(dir, false);
    const response = await service.observe({
      sessionKey: "agent:delegate-test:session-4",
      messages: [{ role: "user", content: USER_TURN }],
    });
    assert.equal(response.transcriptPersisted, false);
    const entries = await readAllTranscriptLines(dir);
    assert.equal(entries.length, 0);
  });
});

test("memory_summarize_hourly warns distinctly when the transcript store is empty (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(dir, true);
    const result = await service.memorySummarizeHourly();
    assert.equal(result.ok, true);
    assert.equal(result.sessionsConsidered, 0);
    assert.equal(result.warning, "transcript store is empty");
    assert.match(result.message, /transcript store is empty/);
  });
});

test("memory_summarize_hourly warns distinctly when the store is stale and the hour was idle (#2783)", async () => {
  await withTempDir(async (dir) => {
    const { service, orchestrator } = makeService(dir, true);
    // Seed one transcript entry far in the past: the store is non-empty but
    // stale, and the target hour has no entries.
    await orchestrator.transcript.append({
      timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      role: "user",
      content: "an old turn from a much earlier hour",
      sessionKey: "agent:delegate-test:session-5",
      turnId: "seed-turn",
    });
    const result = await service.memorySummarizeHourly();
    assert.equal(result.ok, true);
    assert.ok(result.sessionsConsidered > 0);
    assert.equal(result.sessionsWithEntries, 0);
    assert.equal(result.staleStore, true);
    assert.equal(result.warning, "no transcript entries for the target hour and no new entries recently");
  });
});

test("observeTranscriptSessionKey scopes transcripts to the effective write namespace (#2783 review)", async () => {
  const { observeTranscriptSessionKey } = await import("./access-observe-transcript.js");
  const config = { defaultNamespace: "generalist" } as { defaultNamespace: string };
  // Same client-controlled sessionKey from two principals in different
  // namespaces must not share one transcript identity.
  const a = observeTranscriptSessionKey("agent:shared-key:s1", "project-origin-aaa", config);
  const b = observeTranscriptSessionKey("agent:shared-key:s1", "project-origin-bbb", config);
  assert.notEqual(a, b);
  assert.ok(a.includes("project-origin-aaa"));
  assert.ok(b.includes("project-origin-bbb"));
  // A default-store write keeps the raw key (single-store deployments
  // unchanged, mirroring the LCM archive key rules).
  assert.equal(observeTranscriptSessionKey("agent:shared-key:s1", "generalist", config), "agent:shared-key:s1");
});
