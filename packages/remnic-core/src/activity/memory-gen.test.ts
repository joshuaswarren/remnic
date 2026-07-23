import assert from "node:assert/strict";
import test from "node:test";

import { defaultActivityConfig } from "./config.js";
import {
  generateActivityMemories,
  isEligibleActivityFact,
  type ActivityMemoryGenerationDeps,
  type ActivityMemoryWriter,
} from "./memory-gen.js";
import type { ExtractedFact, ImportanceScore } from "../types.js";
import type { JudgeCandidate, JudgeVerdict } from "../extraction-judge.js";
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
  opts: { hasContent?: boolean; dayCount?: number; judgeThrows?: boolean; extractThrows?: boolean; extractionFailure?: string } = {},
) {
  const writes: Array<{
    status: string;
    content: string;
    validAt?: string;
    confidence?: number;
    structuredAttributes?: Readonly<Record<string, string>>;
    importance?: ImportanceScore;
  }> = [];
  let extractCalls = 0;
  const writer: ActivityMemoryWriter = {
    hasActivityMemoryForContent: async () => opts.hasContent ?? false,
    countActivityMemoriesForDay: async () => opts.dayCount ?? 0,
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
        candidates.map((_c, i): [number, JudgeVerdict] => [i, { durable: true, reason: "durable", kind: "accept" }]),
      );
    },
    writer,
  };
  return { writes, extractCalls: () => extractCalls, deps };
}

test("isEligibleActivityFact rejects attributed third-party first-person text", () => {
  // A first-person pronoun quoted from someone else is not the user's own claim.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice wrote: I decided to leave." }), false);
  // Names that merely begin with a pronoun prefix ("Wendy", "Ian") are still
  // third parties — the excluded pronouns are word-anchored.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Wendy said: I will refactor the parser." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Ian posted: I merged the release branch." }), false);
  // The user's own first-person voice stays eligible, including team "we/our".
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "We decided to ship on Friday." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "I updated our deploy runbook." }), true);
  // Case-insensitive verbs and non-Titlecase names still count as attribution.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice Wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "ALICE wrote: I decided to leave." }), false);
  // Colon-style chat/comment sender headers are attribution too.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob: I decided to refactor the parser." }), false);
  // Common document labels are not senders — the user's own note stays eligible.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Note: I decided to refactor the parser." }), true);
  // A chat self-label ("Me:") is the user, not a third party — stays eligible.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Me: I decided to consolidate the settings." }), true);
  // Third-person speakers are attribution, not the user — must be rejected.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "They wrote: I decided to leave." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "He said: I will handle the migration." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "She posted: I closed the incident." }), false);
  // Multi-token sender labels ("Alice Smith:") are attribution.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Alice Smith: I decided to leave." }), false);
  // Multi-word document labels stay eligible via the first-token check.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Action items: I will refactor the parser." }), true);
  // Colon labels with no space after the colon are still attribution.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob:I decided to refactor the parser." }), false);
  // An allowlisted label that names a sender ("Update from Alice:", "Note by Bob:") rejects.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Update from Alice: I decided to cancel the migration." }), false);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Note by Bob: I will handle it." }), false);
  // Verb attribution only fires at the leading position: a first-person decision
  // that mentions a named person's past action in passing stays eligible, while a
  // leading "Name wrote/said" header still rejects.
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "I approved the plan Bob wrote last week." }), true);
  assert.equal(isEligibleActivityFact({ ...ownDecision, content: "Bob wrote: I decided to leave." }), false);
});

test("activity smart mode rejects attributed third-party first-person content before judging", async () => {
  // Genuine first-person ("I decided") but attributed to a named third party,
  // so it must be dropped at the eligibility gate rather than written.
  const attributed = { ...ownDecision, content: "Alice wrote: I decided to leave the project." };
  assert.equal(isEligibleActivityFact(attributed), false);
  const { deps, writes } = depsFor([attributed]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart",
  }, deps);
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 1, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode writes an accepted first-person decision bound to the digest day", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(result.created, 1);
  // validAt is pinned to the digest's local day, not the write instant.
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.content, ownDecision.content);
  assert.equal(writes[0]?.status, "active");
  assert.equal(writes[0]?.validAt, DAY_START);
});

test("activity extraction remains inactive unless smart mode is explicitly enabled", async () => {
  const { deps, writes, extractCalls } = depsFor([ownDecision]);
  const result = await generateActivityMemories(DATE, "## Notable activity", defaultActivityConfig(), deps);
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.equal(extractCalls(), 0);
  assert.deepEqual(writes, []);
});

test("activity day cap seeds from persisted totals and keeps the highest-trust survivor", async () => {
  const strong: ActFact = { category: "decision", content: "I decided to migrate the database.", confidence: 0.99, tags: ["infra"] };
  const weak: ActFact = { category: "decision", content: "I decided to rename the worker pool.", confidence: 0.72, tags: ["infra"] };
  // Two memories already persisted today; cap 3 leaves room for exactly one more.
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
  // The higher-confidence (higher-trust) fact wins the remaining slot.
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
  // Strict compose would throw on the 300-char tag and abort both writes;
  // salvage drops the bad tag so both eligible facts are still persisted.
  assert.equal(result.created, 2);
  assert.deepEqual(writes.map((w) => w.status), ["active", "active"]);
});

test("activity smart mode degrades to trust scoring when the judge throws", async () => {
  const { deps, writes } = depsFor([ownDecision], { judgeThrows: true });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  // A judge failure must not abort the day: with no verdict the fact is scored
  // on confidence x sourceTrust alone (0.95) and still clears autoApproveTrust.
  assert.equal(result.created, 1);
  assert.deepEqual(writes.map((w) => w.status), ["active"]);
});

test("activity smart mode returns a zero result when extraction throws", async () => {
  const { deps, writes } = depsFor([ownDecision], { extractThrows: true });
  const result = await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  // An extraction failure must not throw out of the day's pass.
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
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
  assert.deepEqual(result, { created: 0, pendingReview: 0, rejectedDisplayedContent: 0, rejectedByJudge: 0, skipped: 0 });
  assert.deepEqual(writes, []);
});

test("activity smart mode persists trust score, decision, and judge verdict on the write", async () => {
  const { deps, writes } = depsFor([ownDecision]);
  await generateActivityMemories(DATE, "## Notable activity", {
    ...defaultActivityConfig(), enabled: true, extractionMode: "smart", sourceTrust: 1, autoApproveTrust: 0.8,
  }, deps);
  assert.equal(writes.length, 1);
  const w = writes[0];
  // Decision-derived trust is persisted as confidence (0.95 conf x 1 sourceTrust
  // + 0.15 judge-accept boost, capped at 1), with the rationale in attributes.
  assert.equal(w?.confidence, 1);
  // Structured-attribute keys are canonicalized to lowercase on the envelope.
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
  // Extractor attribute is preserved; the extractor's stray trustScore does not
  // override the path-owned trust key (canonical lowercase).
  assert.equal(sa?.chosen, "option B");
  assert.equal(sa?.trustscore, "1.000");
});
