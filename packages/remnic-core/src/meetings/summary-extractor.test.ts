import assert from "node:assert/strict";
import { test } from "node:test";

import { composeMeetingRecord, type MeetingRecordBase } from "./store.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import {
  generateMeetingSummaryFacts,
  type MeetingFactCandidate,
} from "./memory-gen.js";
import type { MeetingMemoryWriter } from "./memory-generator.js";
import {
  LlmMeetingSummaryExtractor,
  createMeetingSummaryDeps,
  createMeetingSummaryJudge,
  parseMeetingSummaryResponse,
  type MeetingSummaryChatClient,
} from "./summary-extractor.js";
import type { FusedMeeting, MeetingRecord, MeetingsConfig } from "./types.js";
import type { FusedSegment } from "../wearables/fusion/types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import type { MemoryWriteResult } from "../storage.js";
import type { JudgeBatchResult, JudgeCandidate, JudgeVerdict } from "../extraction-judge.js";

const DATE = "2026-03-10";

/** Chat client double: replays canned responses (string, null, or throw) and
 *  records how it was called. `null`/`Error` items exercise chain fallthrough. */
function fakeLlm(script: Array<string | null | Error>): MeetingSummaryChatClient & {
  calls: Array<{ system: string; user: string }>;
} {
  let i = 0;
  return {
    calls: [],
    async chatCompletion(messages) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      this.calls.push({ system, user });
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next === null ? null : { content: next };
    },
  };
}

function segment(text: string): FusedSegment {
  return {
    speaker: "Jane",
    isSelf: false,
    text,
    startIso: "2026-03-10T14:05:00.000Z",
    confidence: 0.9,
    provenance: { source: "desktop", conversationId: "d1", sourceTrust: 0.9, reason: "only-source", alternatives: [] },
  };
}

function fused(overrides: Partial<FusedMeeting> = {}): FusedMeeting {
  return {
    attendees: ["Jane", "Sam"],
    sources: ["desktop", "pendant"],
    corroboratedBy: [],
    screenContext: [],
    contextExcerpts: [],
    transcript: [segment("we shipped v2")],
    speakers: [],
    snapshotCount: 0,
    ...overrides,
  };
}

function record(f: Partial<FusedMeeting> = {}): MeetingRecord {
  const base: MeetingRecordBase = {
    id: "mtg-2026-03-10-abcdef01",
    date: DATE,
    startUtc: "2026-03-10T14:00:00.000Z",
    endUtc: "2026-03-10T14:30:00.000Z",
    app: "Zoom",
    detectionSource: "app+audio",
  };
  return composeMeetingRecord(base, fused(f));
}

function meetingConfig(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns], enabled: true, ...overrides };
}

interface WriteCall {
  envelope: SealedMemoryEnvelope;
  extras: { status?: string; memoryKind?: string };
}

/** In-memory writer modelling the sealed write path + source-scoped dedup. */
class FakeWriter implements MeetingMemoryWriter {
  writes: WriteCall[] = [];
  private bySource = new Map<string, Set<string>>();

  async writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status?: string; memoryKind?: string; contentHashSource?: string },
  ): Promise<MemoryWriteResult> {
    this.writes.push({ envelope, extras });
    if (extras.contentHashSource !== undefined) {
      const set = this.bySource.get(envelope.source) ?? new Set<string>();
      set.add(extras.contentHashSource);
      this.bySource.set(envelope.source, set);
    }
    return { id: `m${this.writes.length}`, path: `moments/m${this.writes.length}.md` } as unknown as MemoryWriteResult;
  }
  async hasMemoryFromSource(source: string, content: string): Promise<boolean> {
    return this.bySource.get(source)?.has(content) ?? false;
  }
  async retireMemoriesFromSource(source: string): Promise<number> {
    const count = this.bySource.get(source)?.size ?? 0;
    this.bySource.delete(source);
    return count;
  }
}

const DECISION_COMMITMENT_QUESTION_JSON = JSON.stringify({
  summary: "The team reviewed the v2 launch and settled the ship date.",
  decisions: ["Ship v2 on Friday"],
  commitments: [{ owner: "Sam", action: "send the launch recap by EOD" }],
  openQuestions: ["Who owns the rollback plan?"],
});

/** A judge closure that returns the given verdict kind for every candidate,
 *  in the shared `JudgeBatchResult` shape `judgeFactDurability` produces. */
function judgeAll(kind: JudgeVerdict["kind"]): (candidates: JudgeCandidate[]) => Promise<JudgeBatchResult> {
  return async (candidates) => {
    const verdicts = new Map<number, JudgeVerdict>();
    candidates.forEach((_, index) => verdicts.set(index, { durable: kind === "accept", reason: "test", kind }));
    return { verdicts, cached: 0, judged: candidates.length, elapsed: 0, deferred: 0, deferredCappedToReject: 0 };
  };
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

test("extractor categorizes decisions, commitments, and open questions from a JSON response", async () => {
  const llm = fakeLlm([DECISION_COMMITMENT_QUESTION_JSON]);
  const extractor = new LlmMeetingSummaryExtractor([llm]);
  const { summary, candidates } = await extractor.extract({
    record: record(),
    transcriptText: "**Jane** [14:05]: we shipped v2",
    screenContextText: "",
  });
  assert.equal(llm.calls.length, 1);
  assert.match(summary, /settled the ship date/);
  const decision = candidates.find((c) => c.category === "decision");
  assert.equal(decision?.content, "Ship v2 on Friday");
  const commitment = candidates.find((c) => c.category === "commitment");
  assert.equal(commitment?.content, "Sam: send the launch recap by EOD", "owner-bearing commitment carries its owner");
  const question = candidates.find((c) => c.category === "fact");
  assert.equal(question?.content, "Open question: Who owns the rollback plan?");
});

test("extractor passes transcript + screen context into the prompt and tolerates code fences", async () => {
  const fenced = "```json\n" + DECISION_COMMITMENT_QUESTION_JSON + "\n```";
  const llm = fakeLlm([fenced]);
  const extractor = new LlmMeetingSummaryExtractor([llm]);
  const res = await extractor.extract({
    record: record(),
    transcriptText: "**Jane** [14:05]: ship it",
    screenContextText: "[14:05] Zoom — Standup",
  });
  assert.equal(res.candidates.length, 3, "a fenced JSON body still parses to 3 candidates");
  assert.match(llm.calls[0]!.user, /## Transcript/);
  assert.match(llm.calls[0]!.user, /ship it/);
  assert.match(llm.calls[0]!.user, /## Screen context/);
  assert.match(llm.calls[0]!.user, /Standup/);
});

test("extractor tolerates malformed output — empty candidates, best-effort summary, never throws", async () => {
  const extractor = new LlmMeetingSummaryExtractor([fakeLlm(["this is not json, just prose about the meeting"])]);
  const res = await extractor.extract({ record: record(), transcriptText: "x", screenContextText: "" });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.summary, "this is not json, just prose about the meeting");
});

test("extractor returns empty when no client yields content (null / empty chain)", async () => {
  const nullRes = await new LlmMeetingSummaryExtractor([fakeLlm([null])]).extract({
    record: record(),
    transcriptText: "x",
    screenContextText: "",
  });
  assert.deepEqual(nullRes, { summary: "", candidates: [] });
  const emptyChain = await new LlmMeetingSummaryExtractor([]).extract({
    record: record(),
    transcriptText: "x",
    screenContextText: "",
  });
  assert.deepEqual(emptyChain, { summary: "", candidates: [] });
});

test("extractor falls through the client chain: a throwing/empty client yields to the next", async () => {
  const first = fakeLlm([new Error("local backend down")]);
  const second = fakeLlm([DECISION_COMMITMENT_QUESTION_JSON]);
  const extractor = new LlmMeetingSummaryExtractor([first, second]);
  const res = await extractor.extract({ record: record(), transcriptText: "x", screenContextText: "" });
  assert.equal(first.calls.length, 1, "the first client was tried");
  assert.equal(second.calls.length, 1, "the chain fell through to the second client");
  assert.equal(res.candidates.length, 3);
});

test("parseMeetingSummaryResponse never throws on garbage and salvages prose", () => {
  assert.deepEqual(parseMeetingSummaryResponse("{ broken json"), { summary: "{ broken json", candidates: [] });
  assert.deepEqual(parseMeetingSummaryResponse(""), { summary: "", candidates: [] });
});

// ---------------------------------------------------------------------------
// Judge adapter
// ---------------------------------------------------------------------------

test("judge adapter maps shared judge verdicts aligned to candidate order", async () => {
  const judge = createMeetingSummaryJudge(async (candidates) => {
    const verdicts = new Map<number, JudgeVerdict>([
      [0, { durable: true, reason: "keep", kind: "accept" }],
      [1, { durable: false, reason: "drop", kind: "reject" }],
      [2, { durable: false, reason: "later", kind: "defer" }],
    ]);
    return { verdicts, cached: 0, judged: candidates.length, elapsed: 0, deferred: 1, deferredCappedToReject: 0 };
  });
  const candidates: MeetingFactCandidate[] = [
    { content: "a decision", category: "decision", confidence: 0.9 },
    { content: "a weak claim", category: "fact", confidence: 0.5 },
    { content: "an ambiguous claim", category: "fact", confidence: 0.6 },
  ];
  assert.deepEqual(await judge.judge(candidates), ["accept", "reject", "defer"]);
});

test("judge adapter degrades to no verdicts (empty array) when the shared judge throws", async () => {
  const judge = createMeetingSummaryJudge(async () => {
    throw new Error("judge backend down");
  });
  assert.deepEqual(await judge.judge([{ content: "x", category: "decision", confidence: 0.9 }]), []);
});

// ---------------------------------------------------------------------------
// Production wiring: the SAME factory workspace-ops injects, driven through the
// real trust-gated generateMeetingSummaryFacts path.
// ---------------------------------------------------------------------------

test("createMeetingSummaryDeps: smart mode writes a trust-gated decision + commitment with meeting provenance", async () => {
  const llm = fakeLlm([DECISION_COMMITMENT_QUESTION_JSON]);
  const { extractor, judge } = createMeetingSummaryDeps({
    localLlm: llm,
    fallbackLlm: null,
    judgeFacts: judgeAll("accept"),
  });
  const writer = new FakeWriter();
  const res = await generateMeetingSummaryFacts(record(), meetingConfig({ summaryMode: "smart" }), {
    extractor,
    judge,
    writer,
  });
  assert.equal(res.llmInvoked, true);
  assert.equal(llm.calls.length, 1, "the production extractor invoked the LLM once");

  const decision = writer.writes.find((w) => w.envelope.category === "decision");
  assert.ok(decision, "a decision fact was written");
  assert.equal(decision!.extras.status, "active", "judge-accepted decision (0.8*0.85+0.15=0.83) is auto-active");
  assert.equal(decision!.envelope.rawStructuredAttributes?.meetingId, "mtg-2026-03-10-abcdef01");

  const commitment = writer.writes.find((w) => w.envelope.category === "commitment");
  assert.ok(commitment, "a commitment fact (category commitment) was written");
  assert.equal(commitment!.extras.status, "active");
  assert.equal(commitment!.envelope.rawStructuredAttributes?.meetingId, "mtg-2026-03-10-abcdef01");
});

test("createMeetingSummaryDeps: off mode makes zero LLM calls", async () => {
  const llm = fakeLlm([DECISION_COMMITMENT_QUESTION_JSON]);
  const { extractor, judge } = createMeetingSummaryDeps({
    localLlm: llm,
    fallbackLlm: null,
    judgeFacts: judgeAll("accept"),
  });
  const writer = new FakeWriter();
  const res = await generateMeetingSummaryFacts(record(), meetingConfig({ summaryMode: "off" }), {
    extractor,
    judge,
    writer,
  });
  assert.equal(res.llmInvoked, false);
  assert.equal(llm.calls.length, 0, "off mode must NEVER invoke the LLM");
  assert.equal(writer.writes.length, 0);
});
