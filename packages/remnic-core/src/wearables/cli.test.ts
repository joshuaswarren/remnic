import assert from "node:assert/strict";
import { test } from "node:test";

import { runWearablesCliCommand } from "./cli.js";
import type { WearablesService } from "./service.js";

function makeIo(): {
  io: { stdout: { write(chunk: string): void }; stderr: { write(chunk: string): void } };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => void out.push(chunk) },
      stderr: { write: (chunk: string) => void err.push(chunk) },
    },
    out,
    err,
  };
}

function stubService(overrides: Partial<Record<keyof WearablesService, unknown>> = {}): WearablesService {
  const base = {
    status: async () => ({
      enabled: true,
      timezone: "UTC",
      sources: [
        {
          source: "limitless",
          displayName: "Limitless Pendant",
          enabled: true,
          connectorInstalled: true,
          memoryMode: "review",
          lastSyncAt: null,
          lastDateSynced: null,
          transcriptDays: 0,
        },
      ],
      connectorsInstalled: ["limitless"],
    }),
    sync: async () => [
      {
        source: "limitless",
        days: ["2026-06-11"],
        conversations: 2,
        segmentsKept: 10,
        segmentsDropped: 1,
        redactions: 1,
        correctionsApplied: 3,
        transcriptsWritten: ["2026-06-11"],
        memoriesCreated: 2,
        memoriesSkipped: 4,
        memoriesBlocked: 0,
        nativeMemoriesImported: 0,
        warnings: ["something minor"],
      },
    ],
    dayTranscript: async () => [],
    searchTranscripts: async () => [],
    transcriptMemories: async () => [],
    listSpeakers: async () => ({ version: 1 as const, selfName: "Me", speakers: {} }),
    checkAuth: async () => ({ ok: true }),
  };
  return { ...base, ...overrides } as unknown as WearablesService;
}

test("no command prints usage and exits 1; help exits 0", async () => {
  const { io, out } = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), [], io), 1);
  assert.match(out.join(""), /Usage: wearables/);
  assert.equal(await runWearablesCliCommand(stubService(), ["help"], makeIo().io), 0);
});

test("unknown commands and flags fail with guidance", async () => {
  const { io, err } = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), ["frobnicate"], io), 1);
  assert.match(err.join(""), /unknown wearables command/);

  const second = makeIo();
  assert.equal(
    await runWearablesCliCommand(stubService(), ["sync", "--bogus"], second.io),
    1,
  );
  assert.match(second.err.join(""), /unknown flag '--bogus'/);
});

test("value-taking flags require a value", async () => {
  const { io, err } = makeIo();
  assert.equal(
    await runWearablesCliCommand(stubService(), ["sync", "--source"], io),
    1,
  );
  assert.match(err.join(""), /--source requires a value/);

  const second = makeIo();
  assert.equal(
    await runWearablesCliCommand(stubService(), ["search", "x", "--limit", "abc"], second.io),
    1,
  );
  assert.match(second.err.join(""), /--limit expects a positive integer/);
});

test("status renders sources and respects --json", async () => {
  const { io, out } = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), ["status"], io), 0);
  const text = out.join("");
  assert.match(text, /Wearables: enabled/);
  assert.match(text, /limitless \(Limitless Pendant\)/);

  const jsonIo = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), ["status", "--json"], jsonIo.io), 0);
  const parsed = JSON.parse(jsonIo.out.join(""));
  assert.equal(parsed.enabled, true);
});

test("sync renders a memories blocked line when writes are tombstone-blocked (#1645)", async () => {
  const { io, out } = makeIo();
  const service = stubService({
    sync: async () => [
      {
        source: "limitless",
        days: ["2026-06-11"],
        conversations: 1,
        segmentsKept: 4,
        segmentsDropped: 0,
        redactions: 0,
        correctionsApplied: 0,
        transcriptsWritten: ["2026-06-11"],
        memoriesCreated: 0,
        memoriesPromoted: 0,
        memoriesDemoted: 0,
        memoriesSkipped: 0,
        memoriesBlocked: 2,
        nativeMemoriesImported: 0,
        warnings: [],
      },
    ],
  });
  assert.equal(await runWearablesCliCommand(service, ["sync"], io), 0);
  const text = out.join("");
  assert.match(text, /memories blocked:\s+2/);
  assert.doesNotMatch(text, /memories created:\s+[1-9]/, "no blocked write counted as created");
});

test("sync renders the summary including warnings", async () => {
  const { io, out } = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), ["sync"], io), 0);
  const text = out.join("");
  assert.match(text, /limitless: 2 conversations/);
  assert.match(text, /memories created:\s+2 \(skipped 4\)/);
  assert.match(text, /warning: something minor/);
  assert.match(text, /OK/);
});

test("transcript requires --date and exits 1 when nothing is stored", async () => {
  const { io, err } = makeIo();
  assert.equal(await runWearablesCliCommand(stubService(), ["transcript"], io), 1);
  assert.match(err.join(""), /requires --date/);

  const second = makeIo();
  assert.equal(
    await runWearablesCliCommand(stubService(), ["transcript", "--date", "2026-06-11"], second.io),
    1,
  );
  assert.match(second.err.join(""), /No stored transcripts/);
});

test("search flags an index-unavailable scan fallback", async () => {
  const service = stubService({
    searchTranscripts: async () => [
      { source: "limitless", date: "2026-06-10", score: 0, snippet: "…solar…", backend: "scan" as const },
    ],
  });
  const { io, out } = makeIo();
  assert.equal(await runWearablesCliCommand(service, ["search", "solar"], io), 0);
  assert.match(out.join(""), /bounded text scan/);
});

test("check maps auth failures to a non-zero exit", async () => {
  const service = stubService({
    checkAuth: async () => ({ ok: false, detail: "bad key" }),
  });
  const { io, out } = makeIo();
  assert.equal(await runWearablesCliCommand(service, ["check", "limitless"], io), 1);
  assert.match(out.join(""), /FAILED — bad key/);
});

test("backend faults propagate instead of being swallowed as exit codes", async () => {
  const service = stubService({
    status: async () => {
      throw new Error("disk exploded");
    },
  });
  await assert.rejects(
    runWearablesCliCommand(service, ["status"], makeIo().io),
    /disk exploded/,
  );
});

test("fuse command requires a date and renders the fuseDay result", async () => {
  const { io, out, err } = makeIo();
  const service = stubService({
    fuseDay: async () => ({
      date: "2026-06-10",
      sources: ["bee", "limitless"],
      conversationCount: 2,
      contentHash: "abc123",
      written: true,
    }),
  });
  assert.equal(await runWearablesCliCommand(service, ["fuse"], io), 1);
  assert.match(err.join(""), /fuse requires a date/);

  // Success path needs its own captured stdout.
  const okIo = makeIo();
  assert.equal(
    await runWearablesCliCommand(service, ["fuse", "2026-06-10"], okIo.io),
    0,
  );
  assert.match(
    okIo.out.join(""),
    /Fused 2026-06-10: 2 conversations from 2 sources/,
  );
});

test("fused command lists conversations and surfaces disagreements (--json)", async () => {
  const { io, out } = makeIo();
  const service = stubService({
    fusedConversations: async () => [
      {
        id: "fusion-1",
        date: "2026-06-10",
        startIso: "2026-06-10T09:00:00.000Z",
        sources: ["bee", "limitless"],
        speakers: [],
        segments: [
          { speaker: "Me (you)", isSelf: true, text: "hi", confidence: 0.8, provenance: { source: "limitless", conversationId: "c1", sourceTrust: 0.8, reason: "only-source", alternatives: [] } },
        ],
        disagreements: [
          { kind: "asr-text", subject: "2026-06-10T09:00:00.000Z", candidates: [{ source: "bee", value: "x" }, { source: "limitless", value: "y" }] },
        ],
        provenance: { contributions: [], proximityGapMs: 300000, windowToleranceMs: 30000, method: "time-proximity" },
      },
    ],
  });
  assert.equal(await runWearablesCliCommand(service, ["fused", "2026-06-10", "--json"], io), 0);
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.date, "2026-06-10");
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0].disagreements.length, 1);

  // Plain-text path surfaces the disagreement count.
  const text = makeIo();
  assert.equal(await runWearablesCliCommand(service, ["fused", "2026-06-10"], text.io), 0);
  assert.match(text.out.join(""), /disagreement \[asr-text\]/);
});

test("fused command reports nothing-fused gracefully", async () => {
  const { io, out } = makeIo();
  const service = stubService({ fusedConversations: async () => [] });
  assert.equal(await runWearablesCliCommand(service, ["fused", "2026-06-10"], io), 0);
  assert.match(out.join(""), /No fused conversations for 2026-06-10/);
});
