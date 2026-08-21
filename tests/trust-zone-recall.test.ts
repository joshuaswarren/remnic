import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  recordTrustZoneRecord,
  searchTrustZoneRecords,
} from "../src/trust-zones.js";

async function seedTrustZoneStore(memoryDir: string) {
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-quarantine-mysql",
      zone: "quarantine",
      recordedAt: "2026-03-07T14:00:00.000Z",
      kind: "external",
      summary: "Raw MySQL outage rumor captured from a single web source.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T13:59:00.000Z",
        sourceId: "https://status.example.com/post-1",
        evidenceHash: "sha256:web-1",
      },
      tags: ["mysql", "outage"],
    },
  });

  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-working-mysql",
      zone: "working",
      recordedAt: "2026-03-07T14:30:00.000Z",
      kind: "state",
      summary: "Working memory says MySQL timeouts likely came from a stale failover event.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T14:29:00.000Z",
        sourceId: "tool:mysql-check",
        evidenceHash: "sha256:tool-2",
      },
      entityRefs: ["service:mysql"],
      tags: ["mysql", "timeouts"],
    },
  });

  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-trusted-mysql",
      zone: "trusted",
      recordedAt: "2026-03-07T15:00:00.000Z",
      kind: "state",
      summary: "Trusted memory confirms the MySQL timeouts came from the stale failover event.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T14:59:00.000Z",
        sourceId: "engram:memory:mysql-failover",
        evidenceHash: "sha256:trusted-3",
      },
      promotedFromZone: "working",
      entityRefs: ["service:mysql"],
      tags: ["mysql", "timeouts", "verified"],
    },
  });
}

async function buildTrustZoneRecallHarness(options: {
  trustZoneRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-recall-"));
  await seedTrustZoneStore(memoryDir);

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    trustZonesEnabled: true,
    trustZoneRecallEnabled: options.trustZoneRecallEnabled,
    recallPipeline: [
      {
        id: "trust-zones",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 3,
        maxChars: 1800,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("searchTrustZoneRecords excludes quarantine material and prefers trusted matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-search-"));
  await seedTrustZoneStore(memoryDir);

  const results = await searchTrustZoneRecords({
    memoryDir,
    query: "What explains the MySQL stale failover timeouts?",
    maxResults: 3,
    sessionKey: "agent:main",
  });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.record.recordId, "tz-trusted-mysql");
  assert.equal(results[1]?.record.recordId, "tz-working-mysql");
  assert.equal(results.some((result) => result.record.zone === "quarantine"), false);
  assert.match(results[0]?.matchedFields.join(",") ?? "", /summary|entityRefs|tags/i);
});

test("searchTrustZoneRecords returns no matches when query normalization strips all tokens", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-stopwords-"));
  await seedTrustZoneStore(memoryDir);

  const results = await searchTrustZoneRecords({
    memoryDir,
    query: "why did it go?",
    maxResults: 3,
    sessionKey: "agent:main",
  });

  assert.deepEqual(results, []);
});

test("recall injects trust-zone section when retrieval is enabled", async () => {
  const orchestrator = await buildTrustZoneRecallHarness({
    trustZoneRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "What trusted memory explains the MySQL stale failover timeouts?",
    "agent:main",
  );

  assert.match(context, /## Trust Zones/);
  assert.match(context, /trusted/i);
  assert.match(context, /Working memory says MySQL timeouts likely came from a stale failover event/i);
  assert.equal(context.includes("tz-quarantine-mysql"), false);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits trust-zone section when retrieval flag is disabled", async () => {
  const orchestrator = await buildTrustZoneRecallHarness({
    trustZoneRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "What trusted memory explains the MySQL stale failover timeouts?",
    "agent:main",
  );

  assert.equal(context.includes("## Trust Zones"), false);
});

test("recall omits trust-zone section when pipeline section is disabled", async () => {
  const orchestrator = await buildTrustZoneRecallHarness({
    trustZoneRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "What trusted memory explains the MySQL stale failover timeouts?",
    "agent:main",
  );

  assert.equal(context.includes("## Trust Zones"), false);
});
