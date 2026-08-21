import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  recordJudgeVerdict,
  readJudgeVerdictStats,
  judgeTelemetryPath,
  EXTRACTION_JUDGE_VERDICT_CATEGORY,
  type JudgeVerdictEvent,
} from "../packages/remnic-core/src/extraction-judge-telemetry.ts";
import {
  judgeFactDurability,
  clearVerdictCache,
  type JudgeCandidate,
  type JudgeVerdictObservation,
} from "../packages/remnic-core/src/extraction-judge.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

async function mkdirTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "judge-telemetry-"));
}

function baseEvent(overrides: Partial<JudgeVerdictEvent> = {}): JudgeVerdictEvent {
  return {
    version: 1,
    category: EXTRACTION_JUDGE_VERDICT_CATEGORY,
    ts: "2026-04-10T12:00:00.000Z",
    verdictKind: "accept",
    reason: "mock",
    deferrals: 0,
    elapsedMs: 12.5,
    candidateCategory: "fact",
    confidence: 0.8,
    contentHash: "hash-" + Math.random().toString(16).slice(2),
    fromCache: false,
    ...overrides,
  };
}

test("PR 3: recordJudgeVerdict is a no-op when disabled", async () => {
  const dir = await mkdirTmp();
  try {
    await recordJudgeVerdict(baseEvent(), { enabled: false, memoryDir: dir });
    // Nothing should be written.
    await assert.rejects(
      readFile(judgeTelemetryPath(dir), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: recordJudgeVerdict appends one JSONL row per call", async () => {
  const dir = await mkdirTmp();
  try {
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "accept", reason: "a" }),
      { enabled: true, memoryDir: dir },
    );
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "defer", reason: "b", deferrals: 1 }),
      { enabled: true, memoryDir: dir },
    );
    const raw = await readFile(judgeTelemetryPath(dir), "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.category, EXTRACTION_JUDGE_VERDICT_CATEGORY);
    assert.equal(first.verdictKind, "accept");
    assert.equal(second.verdictKind, "defer");
    assert.equal(second.deferrals, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: recordJudgeVerdict fails open on directory errors", async () => {
  // Point at a path whose parent cannot be created: a file existing where a
  // directory is expected.
  const dir = await mkdirTmp();
  try {
    // Place a regular file where recordJudgeVerdict wants to mkdir — mkdir
    // { recursive: true } would normally be idempotent; here the *parent*
    // of the parent is a file, so mkdir throws ENOTDIR, which the helper
    // must swallow.
    const blocker = path.join(dir, "state");
    await writeFile(blocker, "not a directory", "utf-8");
    // Must not throw.
    await recordJudgeVerdict(baseEvent(), { enabled: true, memoryDir: dir });
    // And the ledger file was not created (since the write failed silently).
    await assert.rejects(
      readFile(judgeTelemetryPath(dir), "utf-8"),
      /ENOENT|ENOTDIR/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: readJudgeVerdictStats returns zeros on empty/missing ledger", async () => {
  const dir = await mkdirTmp();
  try {
    const stats = await readJudgeVerdictStats(dir);
    assert.equal(stats.total, 0);
    assert.equal(stats.accept, 0);
    assert.equal(stats.reject, 0);
    assert.equal(stats.defer, 0);
    assert.equal(stats.deferRate, 0);
    assert.equal(stats.meanElapsedMs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: readJudgeVerdictStats aggregates kinds + defer rate + mean elapsed", async () => {
  const dir = await mkdirTmp();
  try {
    const opts = { enabled: true, memoryDir: dir };
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "accept", elapsedMs: 10 }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "accept", elapsedMs: 20 }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "reject", elapsedMs: 30 }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ verdictKind: "defer", elapsedMs: 40, deferrals: 1 }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({
        verdictKind: "reject",
        elapsedMs: 50,
        deferCapTriggered: true,
      }),
      opts,
    );

    const stats = await readJudgeVerdictStats(dir);
    assert.equal(stats.total, 5);
    assert.equal(stats.accept, 2);
    assert.equal(stats.reject, 2);
    assert.equal(stats.defer, 1);
    assert.equal(stats.deferCapTriggered, 1);
    assert.equal(stats.deferRate, 1 / 5);
    assert.equal(stats.meanElapsedMs, (10 + 20 + 30 + 40 + 50) / 5);
    assert.ok(stats.firstTs);
    assert.ok(stats.lastTs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: readJudgeVerdictStats respects inclusive sinceMs and exclusive untilMs", async () => {
  // CLAUDE.md gotcha 35: time-range filters must use exclusive upper bounds.
  const dir = await mkdirTmp();
  try {
    const opts = { enabled: true, memoryDir: dir };
    await recordJudgeVerdict(
      baseEvent({ ts: "2026-04-10T00:00:00.000Z", verdictKind: "accept" }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ ts: "2026-04-10T06:00:00.000Z", verdictKind: "reject" }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ ts: "2026-04-10T12:00:00.000Z", verdictKind: "defer" }),
      opts,
    );
    await recordJudgeVerdict(
      baseEvent({ ts: "2026-04-10T18:00:00.000Z", verdictKind: "accept" }),
      opts,
    );

    // Window [06:00, 12:00) must include the 06:00 reject and exclude the
    // 12:00 defer.
    const stats = await readJudgeVerdictStats(dir, {
      sinceMs: Date.parse("2026-04-10T06:00:00.000Z"),
      untilMs: Date.parse("2026-04-10T12:00:00.000Z"),
    });
    assert.equal(stats.total, 1);
    assert.equal(stats.reject, 1);
    assert.equal(stats.accept, 0);
    assert.equal(stats.defer, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: readJudgeVerdictStats counts malformed rows toward malformed, not totals", async () => {
  const dir = await mkdirTmp();
  try {
    await mkdir(path.dirname(judgeTelemetryPath(dir)), { recursive: true });
    const rows = [
      JSON.stringify(baseEvent({ verdictKind: "accept" })),
      "not-json",
      JSON.stringify({ category: "something-else", ts: "2026-04-10T00:00:00Z" }),
      JSON.stringify(
        baseEvent({ verdictKind: "bogus" as unknown as "accept" }),
      ),
      JSON.stringify(baseEvent({ verdictKind: "defer" })),
      "", // blank line — ignored, not counted as malformed
    ];
    await writeFile(
      judgeTelemetryPath(dir),
      rows.join("\n") + "\n",
      "utf-8",
    );
    const stats = await readJudgeVerdictStats(dir);
    assert.equal(stats.total, 2, "Only the two valid rows count toward total");
    assert.equal(stats.malformed, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 3: judge emits onVerdict for every resolved verdict (auto-approve, cache, LLM)", async () => {
  clearVerdictCache();
  const observations: JudgeVerdictObservation[] = [];
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const items = JSON.parse(_msgs[1].content) as Array<{ index: number }>;
      return {
        content: JSON.stringify(
          items.map((it) => ({
            index: it.index,
            kind: "accept",
            durable: true,
            reason: "llm-accept",
          })),
        ),
      };
    },
  };

  const cache = new Map();
  const candidates: JudgeCandidate[] = [
    { text: "correction fact", category: "correction", confidence: 0.9 },
    { text: "critical preference", category: "fact", confidence: 0.9, importanceLevel: "critical" },
    { text: "llm-routed fact body", category: "fact", confidence: 0.7, importanceLevel: "normal" },
  ];

  const cfg = parseConfig({
    memoryDir: ".tmp/x",
    workspaceDir: ".tmp/y",
    openaiApiKey: "test",
    extractionJudgeEnabled: true,
    extractionJudgeBatchSize: 20,
  });

  // First pass: auto-approve + auto-approve + llm
  const r1 = await judgeFactDurability(
    candidates,
    cfg,
    mockLocalLlm as any,
    null,
    cache,
    new Map(),
    (obs) => observations.push(obs),
  );
  assert.equal(r1.verdicts.size, 3);
  assert.equal(observations.length, 3);
  const sources1 = observations.map((o) => o.source).sort();
  assert.deepEqual(sources1, ["auto-approve", "auto-approve", "llm"]);

  // Second pass: the LLM-routed candidate is now cached.
  observations.length = 0;
  const r2 = await judgeFactDurability(
    [candidates[2]],
    cfg,
    mockLocalLlm as any,
    null,
    cache,
    new Map(),
    (obs) => observations.push(obs),
  );
  assert.equal(r2.verdicts.size, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].source, "cache");
});

test("PR 3: judge emits llm-cap-rejected source when defer cap converts to reject", async () => {
  clearVerdictCache();
  const observations: JudgeVerdictObservation[] = [];
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const items = JSON.parse(_msgs[1].content) as Array<{ index: number }>;
      return {
        content: JSON.stringify(
          items.map((it) => ({
            index: it.index,
            kind: "defer",
            durable: false,
            reason: "defer-always",
          })),
        ),
      };
    },
  };
  const cache = new Map();
  const defers = new Map<string, number>();
  const candidates: JudgeCandidate[] = [
    {
      text: "repeatedly ambiguous fact",
      category: "fact",
      confidence: 0.5,
      importanceLevel: "normal",
    },
  ];
  const cfg = parseConfig({
    memoryDir: ".tmp/x",
    workspaceDir: ".tmp/y",
    openaiApiKey: "test",
    extractionJudgeEnabled: true,
    extractionJudgeMaxDeferrals: 1,
  });

  await judgeFactDurability(
    candidates,
    cfg,
    mockLocalLlm as any,
    null,
    cache,
    defers,
    (obs) => observations.push(obs),
  );
  // Second pass: defer count is at cap (1), so this one converts to reject.
  await judgeFactDurability(
    candidates,
    cfg,
    mockLocalLlm as any,
    null,
    cache,
    defers,
    (obs) => observations.push(obs),
  );
  const sources = observations.map((o) => o.source);
  assert.deepEqual(sources, ["llm", "llm-cap-rejected"]);
  assert.equal(observations[0].verdict.kind, "defer");
  assert.equal(observations[1].verdict.kind, "reject");
});

test("PR 3: judge's onVerdict callback failure does not break extraction", async () => {
  clearVerdictCache();
  const candidates: JudgeCandidate[] = [
    { text: "correction", category: "correction", confidence: 0.9 },
  ];
  const cfg = parseConfig({
    memoryDir: ".tmp/x",
    workspaceDir: ".tmp/y",
    openaiApiKey: "test",
    extractionJudgeEnabled: true,
  });
  const r = await judgeFactDurability(
    candidates,
    cfg,
    null,
    null,
    new Map(),
    new Map(),
    () => {
      throw new Error("telemetry boom");
    },
  );
  // Extraction result should still be intact.
  assert.equal(r.verdicts.size, 1);
  assert.equal(r.verdicts.get(0)?.durable, true);
});
