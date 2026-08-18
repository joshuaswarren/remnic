import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMELINE_ANALYSIS_BATCH_OVERLAP,
  TIMELINE_ANALYSIS_BATCH_SIZE,
  TIMELINE_ANALYSIS_PROMPT_VERSION,
  TimelineAnalysisConfigError,
  analyzeTimelineCards,
} from "./analysis.js";
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
  return [
    card({
      id: "card-1",
      startUtc: "2026-08-17T10:00:00.000Z",
      endUtc: "2026-08-17T10:15:00.000Z",
    }),
  ];
}

test("disabled makes zero provider calls and leaves cards unchanged", async () => {
  const cards = sampleCards();
  let calls = 0;
  const result = await analyzeTimelineCards({
    enabled: false,
    cards,
    observations: [observation()],
    provider: "local",
    model: "llama",
    complete: async () => {
      calls += 1;
      return '{"ops":[]}';
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.cards, cards);
  assert.equal(calls, 0);
  assert.equal(result.provider, undefined);
});

test("invalid provider or model throws a typed error and does not call complete", async () => {
  const cards = sampleCards();
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return '{"ops":[]}';
  };
  await assert.rejects(
    () =>
      analyzeTimelineCards({
        enabled: true,
        cards,
        observations: [observation()],
        provider: "",
        model: "llama",
        complete,
      }),
    (err: unknown) => {
      assert.ok(err instanceof TimelineAnalysisConfigError);
      assert.equal(err.code, "invalid_config");
      return true;
    },
  );
  await assert.rejects(
    () =>
      analyzeTimelineCards({
        enabled: true,
        cards,
        observations: [observation()],
        provider: "openai",
        model: "  ",
        complete,
      }),
    TimelineAnalysisConfigError,
  );
  await assert.rejects(
    () =>
      analyzeTimelineCards({
        enabled: true,
        cards,
        observations: [observation()],
        provider: "openai",
        model: "gpt-4.1",
      }),
    TimelineAnalysisConfigError,
  );
  assert.equal(calls, 0);
  assert.equal(cards[0]?.title, "main.ts — editor");
});

test("timeout returns provider_failed and leaves cards unchanged", async () => {
  const cards = sampleCards();
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "openai",
    model: "gpt-4.1",
    timeoutMs: 20,
    complete: () => Promise.withResolvers<string>().promise,
  });
  assert.equal(result.status, "provider_failed");
  assert.equal(result.cards, cards);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1");
});

test("malformed JSON returns invalid_output and leaves cards unchanged", async () => {
  const cards = sampleCards();
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "local",
    model: "llama",
    complete: async () => "not-json {{",
  });
  assert.equal(result.status, "invalid_output");
  assert.equal(result.cards, cards);
});

test("empty input returns invalid_output with zero provider calls", async () => {
  const cards: TimelineCard[] = [];
  let calls = 0;
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [],
    provider: "local",
    model: "llama",
    complete: async () => {
      calls += 1;
      return '{"ops":[]}';
    },
  });
  assert.equal(result.status, "invalid_output");
  assert.equal(result.cards, cards);
  assert.equal(calls, 0);
});

test("valid no-op preserves cards and records prompt metadata", async () => {
  const cards = sampleCards();
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "local",
    model: "llama",
    date: DATE,
    timezone: TZ,
    complete: async () => '{"ops":[]}',
  });
  assert.equal(result.status, "ok");
  assert.equal(result.cards, cards);
  assert.equal(result.provider, "local");
  assert.equal(result.model, "llama");
  assert.equal(result.promptVersion, TIMELINE_ANALYSIS_PROMPT_VERSION);
});

test("prompt instructs evidence-only chronology and forbids invention", async () => {
  let prompt = "";
  await analyzeTimelineCards({
    enabled: true,
    cards: sampleCards(),
    observations: [observation({ browserUrl: "https://example.test/repo" })],
    provider: "openai",
    model: "gpt-4.1",
    date: DATE,
    timezone: TZ,
    complete: async (input) => {
      prompt = input.prompt;
      return '{"ops":[]}';
    },
  });
  assert.match(prompt, /only supplied evidence/i);
  assert.match(prompt, /chronolog/i);
  assert.match(prompt, /do not invent (people|places|tasks)/i);
  assert.match(prompt, /strict JSON/i);
  assert.match(prompt, /productivity|emotional/i);
  assert.ok(prompt.includes("main.ts — editor"));
  assert.ok(prompt.includes("https://example.test/repo"));
});

test("screenshots audio OCR and clipboard are not sent", async () => {
  let prompt = "";
  const dirty = {
    ...observation(),
    screenshot: "PNG-BYTES",
    audio: "WAV-BYTES",
    ocr: "OCR-SECRET",
    clipboard: "CLIP-SECRET",
    keystrokes: "KEY-SECRET",
  } as TimelineObservation;
  await analyzeTimelineCards({
    enabled: true,
    cards: sampleCards(),
    observations: [dirty],
    provider: "local",
    model: "llama",
    complete: async (input) => {
      prompt = input.prompt;
      return '{"ops":[]}';
    },
  });
  assert.equal(prompt.includes("PNG-BYTES"), false);
  assert.equal(prompt.includes("WAV-BYTES"), false);
  assert.equal(prompt.includes("OCR-SECRET"), false);
  assert.equal(prompt.includes("CLIP-SECRET"), false);
  assert.equal(prompt.includes("KEY-SECRET"), false);
});

test("rate limit and abort are provider_failed", async () => {
  const cards = sampleCards();
  const limited = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "openai",
    model: "gpt-4.1",
    complete: async () => {
      throw new Error("429 rate limit");
    },
  });
  assert.equal(limited.status, "provider_failed");
  assert.equal(limited.cards, cards);

  const aborted = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "openai",
    model: "gpt-4.1",
    complete: async ({ signal }) => {
      const err = Object.assign(new Error("aborted"), { name: "AbortError" });
      signal.throwIfAborted?.();
      throw err;
    },
  });
  assert.equal(aborted.status, "provider_failed");
  assert.equal(aborted.cards, cards);
});

test("valid op updates allowed fields and preserves evidence and manual edits", async () => {
  const locked = card({
    id: "locked",
    startUtc: "2026-08-17T10:00:00.000Z",
    endUtc: "2026-08-17T10:10:00.000Z",
    title: "Keep this title",
    manualEdit: { title: "Keep this title", editedAtUtc: "2026-08-17T12:00:00.000Z" },
  });
  const open = card({
    id: "open",
    startUtc: "2026-08-17T10:10:00.000Z",
    endUtc: "2026-08-17T10:20:00.000Z",
    evidenceIds: [2],
    evidenceRange: {
      firstKey: "ws-a|2026-08-17T10:10:00.000Z|hash-2",
      lastKey: "ws-a|2026-08-17T10:10:00.000Z|hash-2",
    },
  });
  const cards = [locked, open];
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [
      observation(),
      observation({
        id: 2,
        capturedAtUtc: "2026-08-17T10:10:00.000Z",
        contentHash: "hash-2",
        windowTitle: "analysis.ts — editor",
      }),
    ],
    provider: "local",
    model: "llama",
    complete: async () =>
      JSON.stringify({
        ops: [
          {
            cardId: "locked",
            title: "Should not apply",
            summary: "ignored",
            categoryId: "browsing",
            confidence: 0.1,
            evidenceRange: locked.evidenceRange,
          },
          {
            cardId: "open",
            title: "analysis.ts — editor",
            summary: "Edited analysis.ts on ws-a",
            categoryId: "development",
            confidence: 0.9,
            uncertainty: "low",
            evidenceRange: open.evidenceRange,
          },
        ],
      }),
  });
  assert.equal(result.status, "ok");
  assert.notEqual(result.cards, cards);
  const nextLocked = result.cards.find((item) => item.id === "locked");
  const nextOpen = result.cards.find((item) => item.id === "open");
  assert.equal(nextLocked?.title, "Keep this title");
  assert.deepEqual(nextLocked?.manualEdit, locked.manualEdit);
  assert.deepEqual(nextLocked?.evidenceRange, locked.evidenceRange);
  assert.equal(nextOpen?.title, "analysis.ts — editor");
  assert.equal(nextOpen?.summary, "Edited analysis.ts on ws-a");
  assert.equal(nextOpen?.confidence, 0.9);
  assert.deepEqual(nextOpen?.evidenceIds, [2]);
  assert.deepEqual(nextOpen?.evidenceRange, open.evidenceRange);
});

test("ops without evidence ranges are invalid_output", async () => {
  const cards = sampleCards();
  const result = await analyzeTimelineCards({
    enabled: true,
    cards,
    observations: [observation()],
    provider: "local",
    model: "llama",
    complete: async () =>
      JSON.stringify({
        ops: [{ cardId: "card-1", title: "Invented Alice in Paris", summary: "mood" }],
      }),
  });
  assert.equal(result.status, "invalid_output");
  assert.equal(result.cards, cards);
});

test("batch constants stay bounded with explicit overlap", () => {
  assert.equal(TIMELINE_ANALYSIS_BATCH_SIZE, 40);
  assert.equal(TIMELINE_ANALYSIS_BATCH_OVERLAP, 2);
  assert.ok(TIMELINE_ANALYSIS_BATCH_OVERLAP < TIMELINE_ANALYSIS_BATCH_SIZE);
});

test("local and remote provider ids are forwarded unchanged", async () => {
  const seen: string[] = [];
  for (const [provider, model] of [
    ["local", "llama"],
    ["openai", "gpt-4.1"],
  ] as const) {
    await analyzeTimelineCards({
      enabled: true,
      cards: sampleCards(),
      observations: [observation()],
      provider,
      model,
      complete: async (input) => {
        seen.push(`${input.provider}/${input.model}`);
        return '{"ops":[]}';
      },
    });
  }
  assert.deepEqual(seen, ["local/llama", "openai/gpt-4.1"]);
});
