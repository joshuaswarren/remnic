import assert from "node:assert/strict";
import test from "node:test";

import { defaultActivityConfig } from "./config.js";
import {
  generateActivityMemories,
  isEligibleActivityFact,
  type ActivityMemoryGenerationDeps,
  type ActivityMemoryWriter,
} from "./memory-gen.js";
import type { ExtractedFact, ImportanceScore, MemoryStatus } from "../types.js";
import type { JudgeCandidate, JudgeVerdict, JudgeVerdictKind } from "../extraction-judge.js";
import { scoreImportance } from "../importance.js";

const DATE = "2026-03-10";
const DAY_START = "2026-03-10T00:00:00.000Z";

type ActFact = Pick<ExtractedFact, "category" | "content" | "confidence" | "tags" | "entityRef" | "structuredAttributes">;

const ownDecision: ActFact = {
  category: "decision",
  content: "I decided to consolidate the account settings.",
  confidence: 0.95,
  tags: ["settings"],
};

function depsFor(
  facts: ActFact[],
  opts: {
    existing?: { id: string; status: MemoryStatus | undefined; key?: string; startUtc?: string } | null;
    promoteResult?: boolean;
    demoteResult?: boolean;
    dayCount?: number;
    judgeThrows?: boolean;
    judgeRejects?: boolean;
    judgeVerdictByIndex?: Record<number, JudgeVerdictKind>;
    extractThrows?: boolean;
    extractionFailure?: string;
  } = {},
) {
  const writes: Array<{
    status: string;
    content: string;
    validAt?: string;
    confidence?: number;
    structuredAttributes?: Readonly<Record<string, string>>;
    importance?: ImportanceScore;
  }> = [];
  const promotions: Array<{ id: string; attrs: Record<string, string>; confidence?: number }> = [];
  const demotions: Array<{ id: string; attrs: Record<string, string> }> = [];
  let extractCalls = 0;
  const writer: ActivityMemoryWriter = {
    findActivityMemoryByContent: async (key, startUtc) => {
      const e = opts.existing;
      if (e === undefined || e === null) return null;
      if (e.key !== undefined && e.key !== key) return null;
      if (e.startUtc !== undefined && e.startUtc !== startUtc) return null;
      return { id: e.id, status: e.status };
    },
    countActivityMemoriesForDay: async () => opts.dayCount ?? 0,
    promoteActivityMemory: async (id, attrs, confidence) => {
      promotions.push({ id, attrs, confidence });
      return opts.promoteResult ?? true;
    },
    demoteActivityMemory: async (id, attrs) => {
      demotions.push({ id, attrs });
      return opts.demoteResult ?? true;
    },
    writeSealedMemory: async (envelope, extras) => {
      writes.push({
        content: envelope.content,
        status: extras.status,
        validAt: envelope.validAt,
        confidence: envelope.confidence,
        structuredAttributes: envelope.structuredAttributes,
        importance: extras.importance,
      });
      return {};
    },
  };
  const deps: ActivityMemoryGenerationDeps = {
    extract: async () => {
      extractCalls += 1;
      if (opts.extractThrows) throw new Error("extract exploded");
      return { facts, profileUpdates: [], entities: [], questions: [], extractionFailure: opts.extractionFailure };
    },
    judge: async (candidates: JudgeCandidate[]) => {
      if (opts.judgeThrows) throw new Error("judge exploded");
      return new Map<number, JudgeVerdict>(
        candidates.map((_c, i): [number, JudgeVerdict] => {
          const kind: JudgeVerdictKind = opts.judgeVerdictByIndex?.[i] ?? (opts.judgeRejects ? "reject" : "accept");
          return [i, { durable: kind === "accept", reason: kind, kind }];
        }),
      );
    },
    writer,
  };
  return { writes, promotions, demotions, extractCalls: () => extractCalls, deps };
}

test("isEligibleActivityFact rejects attributed third-party first-person text", () => {
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Wendy said: I will refactor the parser." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Ian posted: I merged the release branch." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "We decided to ship on Friday." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "I updated our deploy runbook." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice Wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "ALICE wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob: I decided to refactor the parser." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Note: I decided to refactor the parser." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Me: I decided to consolidate the settings." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Us: we decided to ship on Friday." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "They wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "He said: I will handle the migration." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "She posted: I closed the incident." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice Smith: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Action items: I will refactor the parser." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob:I decided to refactor the parser." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Update from Alice: I decided to cancel the migration." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Note by Bob: I will handle it." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "I approved the plan Bob wrote last week." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob wrote: I decided to leave." }), false);
});

test("activity smart mode rejects attributed third-party first-person content before judging", async () => {
  const attributed = { ...ownDecision, content: "Alice wrote: I decided to leave the project." };
  assert.equal(isEligibleActivityFact(attributed), false);
  const { deps, writes } = depsFor([attributed]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart",
  }, deps);
  assert.deepEqual(result, { created: 0, promoted: 0, demoted: 0, pendingReview: 0, rejectedDisplayedContent: 1, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode writes an accepted first-person decision bound to the digest day", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.content, ownDecision.content);
  assert.equal(writes[0]?.status, "active");
  assert.equal(writes[0]?.validAt, DAY_START);
});

test("activity extraction remains inactive unless smart mode is explicitly enabled", async () => {
  const { deps, writes, extractCalls } = depsFor([ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", defaultActivityConfig(), deps);
  assert.deepEqual(result, { created: 0, promoted: 0, demoted: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.equal(extractCalls(), 0);
  assert.deepEqual(writes, []);
});

test("activity day cap seeds from persisted totals and keeps the highest-trust survivor", async () => {
  const strong: ActFact = { category: "decision", content: "I decided to migrate the database.", confidence: 0.99, tags: ["infra"] };
  const weak: ActFact = { category: "decision", content: "I decided to rename the worker pool.", confidence: 0.72, tags: ["infra"] };
  const { deps, writes } = depsFor([weak, strong], { dayCount: 2 });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(),
    enabled: true,
    extractionMode: "smart",
    sourceTrust: 1,
    autoApproveTrust: 0.8,
    maxMemoriesPerDay: 3,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(writes.map((w) => w.content), [strong.content]);
});

test("activity smart mode salvages a malformed optional field instead of aborting the day", async () => {
  const overlongTag = "x".repeat(300);
  const malformed: ActFact = {
    category: "decision",
    content: "I decided to archive stale branches.",
    confidence: 0.95,
    tags: [overlongTag],
  };
  const { deps, writes } = depsFor([malformed, ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 2);
  assert.deepEqual(writes.map((w) => w.status), ["active", "active"]);
});

test("activity smart mode degrades to trust scoring when the judge throws", async () => {
  const { deps, writes } = depsFor([ownDecision], { judgeThrows: true });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.deepEqual(writes.map((w) => w.status), ["active"]);
});

test("activity smart mode returns a zero result when extraction throws", async () => {
  const { deps, writes } = depsFor([ownDecision], { extractThrows: true });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.deepEqual(result, { created: 0, promoted: 0, demoted: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode persists the scored importance on the write", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(writes.length, 1);
  const importance = writes[0]?.importance;
  assert.ok(importance, "write must carry the scored importance");
  const expected = scoreImportance(ownDecision.content, ownDecision.category, ownDecision.tags);
  assert.equal(importance.level, expected.level);
  assert.equal(importance.score, expected.score);
});

test("activity smart mode returns a zero result on an in-band extraction failure", async () => {
  const { deps, writes } = depsFor([ownDecision], { extractionFailure: "provider timeout" });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.deepEqual(result, { created: 0, promoted: 0, demoted: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode persists trust score, decision, and judge verdict on the write", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(writes.length, 1);
  const w = writes[0];
  assert.equal(w?.confidence, 1);
  assert.equal(w?.structuredAttributes?.trustscore, "1.000");
  assert.equal(w?.structuredAttributes?.trustdecision, "auto-approved");
  assert.equal(w?.structuredAttributes?.judgeverdict, "accept");
});

test("activity smart mode preserves extracted attributes without overriding trust keys", async () => {
  const fact: ActFact = { ...ownDecision, structuredAttributes: { chosen: "option B", trustScore: "0.001" } };
  const { deps, writes } = depsFor([fact]);
  await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(writes.length, 1);
  const sa = writes[0]?.structuredAttributes;
  assert.equal(sa?.chosen, "option B");
  assert.equal(sa?.trustscore, "1.000");
});

test("activity smart mode promotes a pending_review duplicate on a stronger reassessment", async () => {
  const { deps, writes, promotions } = depsFor([ownDecision], { existing: { id: "mem-1", status: "pending_review" } });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.promoted, 1);
  assert.equal(result.created, 0);
  assert.deepEqual(writes, []);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.id, "mem-1");
  assert.equal(promotions[0]?.attrs.trustDecision, "promoted-by-reassessment");
});

test("activity smart mode demotes a pending_review duplicate on a fresh judge reject", async () => {
  const { deps, writes, demotions } = depsFor([ownDecision], {
    existing: { id: "mem-2", status: "pending_review" },
    judgeRejects: true,
  });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.demoted, 1);
  assert.equal(result.rejectedByJudge, 0);
  assert.deepEqual(writes, []);
  assert.equal(demotions.length, 1);
  assert.equal(demotions[0]?.id, "mem-2");
});

test("activity smart mode skips an existing active duplicate without promoting", async () => {
  const { deps, writes, promotions } = depsFor([ownDecision], { existing: { id: "mem-3", status: "active" } });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.skipped, 1);
  assert.equal(result.promoted, 0);
  assert.deepEqual(writes, []);
  assert.equal(promotions.length, 0);
});

test("activity smart mode suppresses intra-run duplicate content", async () => {
  const { deps, writes } = depsFor([ownDecision, { ...ownDecision }]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(writes.length, 1);
});

test("activity smart mode rejects a non-finite confidence before the floor", async () => {
  const fact: ActFact = { ...ownDecision, confidence: Number.NaN };
  const { deps, writes } = depsFor([fact]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(writes, []);
});

test("activity smart mode dedups whitespace/case content variants within a pass", async () => {
  const a: ActFact = { ...ownDecision, content: "I decided to consolidate the settings." };
  const b: ActFact = { ...ownDecision, content: "  I DECIDED to Consolidate the Settings.  " };
  const { deps, writes } = depsFor([a, b]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(writes.length, 1);
});

test("activity smart mode keeps the stronger duplicate over a weaker earlier reject", async () => {
  const first: ActFact = { ...ownDecision, confidence: 0.8 };
  const second: ActFact = { ...ownDecision, confidence: 0.99 };
  const { deps, writes } = depsFor([first, second], { judgeVerdictByIndex: { 0: "reject", 1: "accept" } });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(result.rejectedByJudge, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.status, "active");
});

test("activity smart mode treats same-day duplicate content as a duplicate", async () => {
  const { deps, writes } = depsFor([ownDecision], { existing: { id: "m-sameday", status: "active", startUtc: DAY_START } });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(writes, []);
});

test("activity smart mode writes recurring content on a different day (day-scoped dedup)", async () => {
  const { deps, writes } = depsFor([ownDecision], { existing: { id: "m-day1", status: "active", startUtc: DAY_START } });
  const result = await generateActivityMemories("2026-03-11", "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(writes.length, 1);
});

test("activity smart mode keeps the durable duplicate over a higher-confidence reject", async () => {
  const rejectHiConf: ActFact = { ...ownDecision, confidence: 0.99 };
  const acceptLoConf: ActFact = { ...ownDecision, confidence: 0.72 };
  const { deps, writes } = depsFor([rejectHiConf, acceptLoConf], { judgeVerdictByIndex: { 0: "reject", 1: "accept" } });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(result.rejectedByJudge, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.status, "active");
});

test("activity smart extraction runs on extractionMode alone, not the enabled ingestion gate", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: false, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  assert.equal(writes.length, 1);
});

test("activity smart mode retains trust fields even when the extractor floods structured attributes", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 64; i += 1) many[`k${i}`] = `v${i}`;
  const fact: ActFact = { ...ownDecision, structuredAttributes: many };
  const { deps, writes } = depsFor([fact]);
  await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(writes.length, 1);
  const sa = writes[0]?.structuredAttributes;
  assert.equal(sa?.trustscore, "1.000");
  assert.equal(sa?.trustdecision, "auto-approved");
  assert.equal(sa?.judgeverdict, "accept");
});
