/**
 * Provider-contract and surface tests for timeline-card analysis (issue #2050).
 *
 * Every acceptance path runs against synthetic observations through the
 * local/remote client seams — no network, no real provider. Prompt and
 * response content are captured by the fakes and asserted locally.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runTimelineCardAnalysis } from "./analysis-run.js";
import {
  classifyAnalysisProviderError,
  timelineAnalysisCompleteFromClients,
  TimelineAnalysisProviderError,
} from "./analysis-provider.js";
import type { TimelineAnalysisLocalLlm, TimelineAnalysisRemoteLlm } from "./analysis-provider.js";
import type { ActivityTimelineAnalysisConfig } from "../types.js";
import type { TimelineCard, TimelineObservation } from "./types.js";

const DATE = "2026-08-17";
const TZ = "UTC";

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id" | "startUtc" | "endUtc">,
): TimelineCard {
  return {
    kind: "activity",
    title: "main.ts — editor",
    summary: "Code editor on ws-a",
    categoryId: "development",
    confidence: 0.8,
    dayKey: DATE,
    timezone: TZ,
    machine: "ws-a",
    evidenceIds: [1],
    evidenceRange: {
      firstKey: "ws-a|2026-08-17T10:00:00.000Z|hash-1",
      lastKey: "ws-a|2026-08-17T10:00:00.000Z|hash-1",
    },
    ...overrides,
  };
}

function observation(overrides: Partial<TimelineObservation> = {}): TimelineObservation {
  return {
    id: 1,
    machine: "ws-a",
    capturedAtUtc: "2026-08-17T10:00:00.000Z",
    app: "editor",
    windowTitle: "main.ts — editor",
    contentHash: "hash-1",
    ...overrides,
  };
}

function sampleCards(): TimelineCard[] {
  return [card({ id: "card-1", startUtc: "2026-08-17T10:00:00.000Z", endUtc: "2026-08-17T10:15:00.000Z" })];
}

const ENABLED: ActivityTimelineAnalysisConfig = { enabled: true, provider: "openai", model: "gpt-test" };

interface RecordedCall {
  messages: Array<{ role: string; content: string }>;
  options: Record<string, unknown>;
}

function fakeLocal(handler: (call: RecordedCall) => Promise<{ content: string } | null>) {
  const calls: RecordedCall[] = [];
  const localLlm: TimelineAnalysisLocalLlm = {
    chatCompletion: async (messages, options) => {
      const call = { messages, options: options as unknown as Record<string, unknown> };
      calls.push(call);
      return handler(call);
    },
  };
  return { localLlm, calls };
}

function fakeRemote(handler: (call: RecordedCall) => Promise<{ content: string } | null>) {
  const calls: RecordedCall[] = [];
  const remoteLlm: TimelineAnalysisRemoteLlm = {
    chatCompletion: async (messages, options) => {
      const call = { messages, options: options as unknown as Record<string, unknown> };
      calls.push(call);
      return handler(call);
    },
  };
  return { remoteLlm, calls };
}

test("disabled config makes zero provider calls and produces zero analysis artifacts", async () => {
  const cards = sampleCards();
  const local = fakeLocal(async () => ({ content: '{"ops":[]}' }));
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards,
    observations: [observation()],
    config: { enabled: false },
    deps: { localLlm: local.localLlm, remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.cards, cards);
  assert.equal(local.calls.length + remote.calls.length, 0);
  assert.equal(result.failure, undefined);
  assert.equal(result.metadata, undefined);
});

test("remote provider is pinned to the single configured model with no chain fallback", async () => {
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards: sampleCards(),
    observations: [observation()],
    config: ENABLED,
    deps: { remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "ok");
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(remote.calls[0]?.options.modelChain, { primary: "openai/gpt-test" });
  assert.equal(remote.calls[0]?.options.includeDefaultModelFallback, false);
  assert.deepEqual(result.metadata, {
    provider: "openai",
    model: "gpt-test",
    promptVersion: "1",
    observationCount: 1,
  });
});

test("local provider routes to the local client seam", async () => {
  const local = fakeLocal(async () => ({ content: '{"ops":[]}' }));
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards: sampleCards(),
    observations: [observation()],
    config: { ...ENABLED, provider: "local", model: "qwen3.8-27b" },
    deps: { localLlm: local.localLlm, remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "ok");
  assert.equal(local.calls.length, 1);
  assert.equal(remote.calls.length, 0);
  assert.equal(local.calls[0]?.options.operation, "timeline-analysis");
  assert.equal(local.calls[0]?.options.model, "qwen3.8-27b");
  assert.equal(result.metadata?.provider, "local");
  assert.equal(result.metadata?.model, "qwen3.8-27b");
});

test("prompt carries evidence-only chronology and strict-output instructions with only safe fields", async () => {
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards: sampleCards(),
    observations: [observation({ browserUrl: "https://example.test/repo" })],
    config: ENABLED,
    deps: { remoteLlm: remote.remoteLlm },
  });
  const prompt = remote.calls[0]?.messages[0]?.content ?? "";
  for (const phrase of [
    "Use only supplied evidence",
    "Preserve chronology",
    "Do not invent people, places, or tasks",
    "Avoid productivity or emotional claims",
    "Return strict JSON",
  ]) {
    assert.ok(prompt.includes(phrase), `prompt must instruct: ${phrase}`);
  }
  // The prompt is "<instructions>\n<payload JSON>"; the payload is line 2.
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  assert.deepEqual(Object.keys(payload.observations[0]).sort(), [
    "app",
    "browserUrl",
    "capturedAtUtc",
    "contentHash",
    "id",
    "machine",
    "windowTitle",
  ]);
  // No raw capture channels exist on the observation payload: the type carries
  // none, and the wire shape proves nothing extra was smuggled in.
  assert.equal(JSON.stringify(payload).includes("textSource"), false);
});

test("observations outside the day window are never sent", async () => {
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards: sampleCards(),
    observations: [
      observation({ id: 1 }),
      observation({ id: 2, capturedAtUtc: "2026-08-16T23:59:59.999Z", contentHash: "hash-2" }),
    ],
    config: ENABLED,
    deps: { remoteLlm: remote.remoteLlm },
  });
  const prompt = remote.calls[0]?.messages[0]?.content ?? "";
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  assert.equal(payload.observations.length, 1);
  assert.equal(result.metadata?.observationCount, 1);
});

test("an impossible date or timezone throws before any provider contact", async () => {
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  await assert.rejects(
    () =>
      runTimelineCardAnalysis({
        date: "2026-02-30",
        timezone: TZ,
        cards: sampleCards(),
        observations: [observation()],
        config: ENABLED,
        deps: { remoteLlm: remote.remoteLlm },
      }),
    RangeError,
  );
  await assert.rejects(
    () =>
      runTimelineCardAnalysis({
        date: DATE,
        timezone: "Not/AZone",
        cards: sampleCards(),
        observations: [observation()],
        config: ENABLED,
        deps: { remoteLlm: remote.remoteLlm },
      }),
    RangeError,
  );
  assert.equal(remote.calls.length, 0);
});

test("missing provider seam returns a typed provider_unavailable failure and unchanged cards", async () => {
  const cards = sampleCards();
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards,
    observations: [observation()],
    config: { ...ENABLED, provider: "local" },
    deps: { localLlm: null, remoteLlm: null },
  });
  assert.equal(result.status, "provider_failed");
  assert.equal(result.cards, cards);
  assert.deepEqual(result.failure, { kind: "provider_unavailable", retryable: true, preservesDeterministic: true });
});

test("unconfigured remote provider returns null and never falls back to another provider", async () => {
  const remote = fakeRemote(async () => null);
  const cards = sampleCards();
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards,
    observations: [observation()],
    config: { ...ENABLED, provider: "no-such-provider" },
    deps: { remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "provider_failed");
  assert.equal(result.cards, cards);
  assert.equal(result.failure?.kind, "provider_unavailable");
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(remote.calls[0]?.options.modelChain, { primary: "no-such-provider/gpt-test" });
});

for (const [name, error, kind] of [
  ["timeout", Object.assign(new Error("timeline analysis timed out"), { name: "TimeoutError" }), "timeout"],
  ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "aborted"],
  ["rate limit status", Object.assign(new Error("HTTP 429"), { status: 429 }), "rate_limited"],
  ["generic provider crash", new Error("socket hang up"), "provider_unavailable"],
] as const) {
  test(`${name} returns the typed failure kind and leaves cards byte-identical`, async () => {
    const cards = sampleCards();
    const remote = fakeRemote(async () => {
      throw error;
    });
    const result = await runTimelineCardAnalysis({
      date: DATE,
      timezone: TZ,
      cards,
      observations: [observation()],
      config: ENABLED,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(result.status, "provider_failed");
    assert.equal(result.cards, cards);
    assert.equal(result.failure?.kind, kind);
    assert.equal(result.failure?.preservesDeterministic, true);
  });
}

for (const [name, body, kind] of [
  ["empty response body", "", "partial_output"],
  ["malformed JSON", "the model rambled, no json here", "malformed_json"],
  ["json without ops", '{"summary":"no ops key"}', "invalid_schema"],
  ["ops with an invalid entry", '{"ops":[{"cardId":"card-1"}]}', "invalid_schema"],
] as const) {
  test(`${name} is typed ${kind} and leaves cards unchanged`, async () => {
    const cards = sampleCards();
    const remote = fakeRemote(async () => ({ content: body }));
    const result = await runTimelineCardAnalysis({
      date: DATE,
      timezone: TZ,
      cards,
      observations: [observation()],
      config: ENABLED,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(result.status, "invalid_output");
    assert.equal(result.cards, cards);
    assert.equal(result.failure?.kind, kind);
  });
}

test("a valid op updates only allowed fields and preserves manual edits and evidence", async () => {
  const locked = card({
    id: "locked",
    startUtc: "2026-08-17T11:00:00.000Z",
    endUtc: "2026-08-17T11:15:00.000Z",
    manualEdit: { editedAtUtc: "2026-08-17T12:00:00.000Z", title: "kept" },
  });
  const open = card({ id: "open", startUtc: "2026-08-17T10:00:00.000Z", endUtc: "2026-08-17T10:15:00.000Z" });
  const remote = fakeRemote(
    async () =>
      ({
        content: JSON.stringify({
          ops: [
            {
              cardId: "open",
              title: "Refined title",
              summary: "Editor work bound to the supplied window",
              categoryId: "development",
              confidence: 0.9,
              uncertainty: "Title inferred from window title only",
              evidenceRange: { firstKey: "ws-a|2026-08-17T10:00:00.000Z|hash-1", lastKey: "ws-a|2026-08-17T10:00:00.000Z|hash-1" },
            },
          ],
        }),
      }) as { content: string },
  );
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards: [locked, open],
    observations: [observation()],
    config: ENABLED,
    deps: { remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "ok");
  const updated = result.cards.find((entry) => entry.id === "open");
  const untouched = result.cards.find((entry) => entry.id === "locked");
  assert.equal(updated?.title, "Refined title");
  assert.equal(updated?.confidence, 0.9);
  assert.deepEqual(updated?.evidenceRange, open.evidenceRange);
  assert.deepEqual(updated?.evidenceIds, [1]);
  assert.equal(untouched?.title, "main.ts — editor");
  assert.ok(untouched?.manualEdit);
});

test("empty input returns invalid_output with zero provider calls", async () => {
  const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
  const cards: TimelineCard[] = [];
  const result = await runTimelineCardAnalysis({
    date: DATE,
    timezone: TZ,
    cards,
    observations: [],
    config: ENABLED,
    deps: { remoteLlm: remote.remoteLlm },
  });
  assert.equal(result.status, "invalid_output");
  assert.equal(result.cards, cards);
  assert.equal(remote.calls.length, 0);
});

test("provider error classification is name/status based and total", () => {
  assert.equal(classifyAnalysisProviderError(new TimelineAnalysisProviderError("rate_limited", "x")), "rate_limited");
  assert.equal(
    classifyAnalysisProviderError(Object.assign(new Error("HTTP 429"), { status: 429 })),
    "rate_limited",
  );
  assert.equal(
    classifyAnalysisProviderError(new Error("Rate limit exceeded, retry later")),
    "rate_limited",
  );
  assert.equal(
    classifyAnalysisProviderError(Object.assign(new Error("x"), { name: "AbortError" })),
    "aborted",
  );
  assert.equal(
    classifyAnalysisProviderError(Object.assign(new Error("x"), { name: "TimeoutError" })),
    "timeout",
  );
  assert.equal(classifyAnalysisProviderError(new Error("socket hang up")), "provider_unavailable");
  assert.equal(classifyAnalysisProviderError("not an error"), "provider_unavailable");
});

test("adapter pins the call-time provider verbatim with no chain fallback", async () => {
  const seen: string[] = [];
  const remoteLlm: TimelineAnalysisRemoteLlm = {
    chatCompletion: async (_messages, options) => {
      seen.push(options.modelChain?.primary ?? "");
      assert.equal(options.includeDefaultModelFallback, false);
      return { content: '{"ops":[]}' };
    },
  };
  const complete = timelineAnalysisCompleteFromClients({ localLlm: null, remoteLlm });
  await complete({
    prompt: "p",
    provider: "anthropic",
    model: "claude-4_1",
    signal: new AbortController().signal,
  });
  assert.deepEqual(seen, ["anthropic/claude-4_1"]);
});
