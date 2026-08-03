import assert from "node:assert/strict";
import test from "node:test";

import {
  AMBIENT_CAPTURE_PROMPT_RULE,
  SPECULATIVE_CONFIDENCE_CEILING,
  clampAmbientCaptureConfidence,
  isHighImpactPersonalFact,
} from "./ambient-provenance.js";
import { parseConfig } from "./config.js";
import { bufferTurnsEqual, copyBufferTurn } from "./buffer-turn-helpers.js";
import { ExtractionEngine } from "./extraction.js";
import { SUMMARY_SYSTEM_PROMPT } from "./meetings/summary-extractor.js";
import { emptySpeakerRegistry } from "./wearables/speakers.js";
import { buildExtractionTurns } from "./wearables/memory-gen.js";
import type { WearableConversation } from "./wearables/types.js";
import { decideSmart } from "./wearables/trust.js";
import type { BufferTurn, ExtractedFact, ExtractionResult, MemoryCategory } from "./types.js";

/**
 * Ambient-capture contamination (issue #2294): a wearable records a TV show,
 * a scripted line names a relative's birthday, and extraction emits it as a
 * high-confidence personal fact that auto-promotes into recall.
 *
 * The fix has two halves and both are exercised here: the prompt section that
 * tells the model to separate the user's speech from background media, and the
 * deterministic clamp that holds high-impact personal facts at the speculative
 * ceiling when the model ignores it. Every extraction path — local LLM, direct
 * client, gateway fallback — must apply both.
 */

const AMBIENT_LINE = "Rachel's mother has a birthday on June 3rd.";

const AMBIENT_TURN: BufferTurn = {
  role: "user",
  content: `[Wearable transcript (fixture) — 2026-08-02]\nSpeaker 2: ${AMBIENT_LINE}`,
  timestamp: "2026-08-02T12:00:00.000Z",
  ambientCapture: true,
};

const TYPED_TURN: BufferTurn = {
  role: "user",
  content: AMBIENT_TURN.content,
  timestamp: AMBIENT_TURN.timestamp,
};

const HIGH_IMPACT_EXTRACTION = {
  facts: [
    {
      category: "fact",
      content: AMBIENT_LINE,
      confidence: 0.91,
      tags: ["personal"],
    },
  ],
  profileUpdates: [],
  entities: [],
  questions: [],
};

type ChatMessage = { role: string; content: string };

/**
 * The mocks below mirror the production signatures exactly — `chatCompletion`
 * takes an options object, `parseWithSchemaDetailed` takes a schema then
 * options, and the direct client's `create` takes the full request body. A
 * narrower mock would let the request contract drift underneath a green test.
 */

const MODEL_REGISTRY_FIXTURE = {
  calculateContextSizes: () => ({
    maxInputChars: 8_000,
    maxOutputTokens: 1_000,
    description: "fixture",
  }),
};

/** Run the local-LLM path, returning the prompt the model saw + the result. */
async function runLocal(turns: BufferTurn[]): Promise<{ prompt: string; result: ExtractionResult }> {
  const engine = new ExtractionEngine(
    parseConfig({ localLlmEnabled: true, localLlmModel: "fixture-local", localLlmFallback: false }),
  );
  let prompt = "";
  const localLlm = {
    async chatCompletion(messages: ChatMessage[], _options: { signal?: AbortSignal } = {}) {
      prompt = messages[1]?.content ?? "";
      return { content: JSON.stringify(HIGH_IMPACT_EXTRACTION) };
    },
  };
  assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
  assert.equal(Reflect.set(engine, "modelRegistry", MODEL_REGISTRY_FIXTURE), true);
  return { result: await engine.extract(turns), prompt };
}

/** Run the gateway-fallback path. */
async function runGateway(turns: BufferTurn[]): Promise<{ prompt: string; result: ExtractionResult }> {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  let prompt = "";
  const fallbackLlm = {
    async parseWithSchemaDetailed(
      messages: ChatMessage[],
      _schema: { parse: (data: unknown) => unknown },
      _options: { signal?: AbortSignal } = {},
    ) {
      prompt = messages[0]?.content ?? "";
      return { modelUsed: "fixture-gateway", result: HIGH_IMPACT_EXTRACTION };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);
  return { result: await engine.extract(turns), prompt };
}

/** Run the direct OpenAI-compatible client path. */
async function runDirect(turns: BufferTurn[]): Promise<{ prompt: string; result: ExtractionResult }> {
  const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
  let prompt = "";
  const client = {
    chat: {
      completions: {
        async create(
          request: { model: string; messages: ChatMessage[] },
          _requestOptions?: { signal?: AbortSignal },
        ) {
          prompt = request.messages[0]?.content ?? "";
          return { choices: [{ message: { content: JSON.stringify(HIGH_IMPACT_EXTRACTION) } }] };
        },
      },
    },
  };
  assert.equal(Reflect.set(engine, "client", client), true);
  return { result: await engine.extract(turns), prompt };
}

const PATHS: Array<[string, (turns: BufferTurn[]) => Promise<{ prompt: string; result: ExtractionResult }>]> = [
  ["local LLM", runLocal],
  ["gateway fallback", runGateway],
  ["direct client", runDirect],
];

for (const [name, run] of PATHS) {
  test(`${name}: ambient turns add the provenance warning to the prompt`, async () => {
    const { prompt } = await run([AMBIENT_TURN]);

    assert.match(prompt, /always-on capture/i);
    assert.match(prompt, /television|TV/);
    assert.match(prompt, /speculative tier \(0\.00-0\.39\)/i);
  });

  test(`${name}: typed turns keep the prompt free of ambient-capture text`, async () => {
    const { prompt } = await run([TYPED_TURN]);

    assert.doesNotMatch(prompt, /always-on capture/i);
    assert.doesNotMatch(prompt, /ambient/i);
  });

  test(`${name}: a high-impact personal fact from ambient audio is clamped to speculative`, async () => {
    const { result } = await run([AMBIENT_TURN]);

    assert.equal(result.facts.length, 1, "the fact survives extraction, downgraded rather than dropped");
    assert.equal(result.facts[0]?.confidence, SPECULATIVE_CONFIDENCE_CEILING);
  });

  test(`${name}: the same fact typed by the user keeps its confidence`, async () => {
    const { result } = await run([TYPED_TURN]);

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.confidence, 0.91);
  });
}

test("an ambient turn marked context-only does not trigger the ambient prompt", async () => {
  const { prompt } = await runGateway([
    { ...AMBIENT_TURN, extractionContextOnly: true },
    TYPED_TURN,
  ]);

  assert.doesNotMatch(prompt, /always-on capture/i);
});

test("the proactive second pass carries the ambient warning into its own prompts", async () => {
  // The proactive pass makes extra LLM calls on the same conversation and
  // merges their additions. Without the flag those prompts had no media
  // warning at all, so a background line could return as a confident fact.
  const engine = new ExtractionEngine(
    parseConfig({
      modelSource: "gateway",
      proactiveExtractionEnabled: true,
      maxProactiveQuestionsPerExtraction: 2,
    }),
  );
  const prompts: string[] = [];
  const fallbackLlm = {
    async parseWithSchemaDetailed(
      messages: ChatMessage[],
      _schema: { parse: (data: unknown) => unknown },
      _options: { signal?: AbortSignal } = {},
    ) {
      prompts.push(messages.map((m) => m.content).join("\n"));
      return { modelUsed: "fixture-gateway", result: HIGH_IMPACT_EXTRACTION };
    },
    // Question generation goes through parseWithSchema, answering through
    // parseWithSchemaDetailed — the mock must offer both or the pass aborts.
    async parseWithSchema(
      messages: ChatMessage[],
      _schema: { parse: (data: unknown) => unknown },
      _options: { signal?: AbortSignal } = {},
    ) {
      prompts.push(messages.map((m) => m.content).join("\n"));
      return { questions: [{ question: "What else was said?", context: "", priority: 0.9 }] };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

  await engine.extract([AMBIENT_TURN]);

  assert.ok(prompts.length > 1, "the proactive pass issued at least one extra call");
  for (const [index, prompt] of prompts.entries()) {
    assert.match(prompt, /ambient|always-on capture/i, `prompt ${index} carries the media warning`);
  }
});

test("ordinary ambient facts keep their confidence — only high-impact classes clamp", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  const line = "The team uses PostgreSQL for the primary store.";
  const fallbackLlm = {
    async parseWithSchemaDetailed(
      _messages: ChatMessage[],
      _schema: { parse: (data: unknown) => unknown },
      _options: { signal?: AbortSignal } = {},
    ) {
      return {
        modelUsed: "fixture-gateway",
        result: {
          facts: [{ category: "fact", content: line, confidence: 0.88, tags: ["tools"] }],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
      };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

  const result = await engine.extract([
    { ...AMBIENT_TURN, content: `[Wearable transcript (fixture) — 2026-08-02]\nSpeaker 1: ${line}` },
  ]);

  assert.equal(result.facts[0]?.confidence, 0.88);
});

function claim(content: string, tags: string[] = [], category: MemoryCategory = "fact") {
  return { category, content, tags };
}

test("isHighImpactPersonalFact flags family, milestone, and medical content", () => {
  for (const content of [
    "Rachel's mother has a birthday on June 3rd.",
    "Their wedding anniversary is in October.",
    "He was diagnosed with diabetes last spring.",
    "Her surgery is scheduled for Tuesday.",
    "The funeral is on Saturday.",
    // The health wording an earlier term list missed (review round 1).
    "The user is HIV-positive.",
    "He has depression.",
    "She suffered a heart attack in March.",
    "He is in remission after chemotherapy.",
    "Her blood pressure medication was changed.",
    // Everyday wording an earlier expansion still missed (review round 3).
    "Dana has COVID-19.",
    "She caught the flu last week.",
  ]) {
    assert.equal(isHighImpactPersonalFact(claim(content)), true, content);
  }
});

test("isHighImpactPersonalFact flags personal-claim-shaped categories with no matching word", () => {
  assert.equal(isHighImpactPersonalFact(claim("Dana leads the Helsinki office.", [], "relationship")), true);
  assert.equal(isHighImpactPersonalFact(claim("They closed on the new place.", [], "moment")), true);
});

test("isHighImpactPersonalFact flags bodily harm by sentence shape, not by condition name", () => {
  // No condition vocabulary can be complete, so the injury/contagion SHAPE is
  // matched directly — a harm verb pointed at a person's possession.
  for (const content of [
    "Dana broke her leg.",
    "He tore his ACL playing soccer.",
    "She bruised her wrist on the stairs.",
    "Their grandfather passed away in March.",
    "He was rushed to the hospital.",
  ]) {
    assert.equal(isHighImpactPersonalFact(claim(content)), true, content);
  }
  // Articles are excluded on purpose: a broken build is not a broken bone.
  assert.equal(isHighImpactPersonalFact(claim("The build broke the deploy pipeline.", ["tools"])), false);
});

test("a claim attached to a person entity is high-impact whatever it says", () => {
  // The lexicon-free catch-all: extraction normalizes people to `person-<name>`,
  // so wording no list anticipates is still flagged when it is about a person.
  assert.equal(
    isHighImpactPersonalFact({ category: "fact", content: "Dana is deaf.", entityRef: "person-dana" }),
    true,
  );
  assert.equal(
    isHighImpactPersonalFact({ category: "fact", content: "Some wording no list anticipates.", entityRef: "person-dana" }),
    true,
  );
  assert.equal(
    isHighImpactPersonalFact({ category: "fact", content: "Ships on Fridays.", entityRef: "project-remnic" }),
    false,
    "non-person entities are unaffected",
  );
});

test("isHighImpactPersonalFact flags disability and chronic-condition wording", () => {
  for (const content of ["Dana is deaf.", "Dana is blind.", "Dana has multiple sclerosis.", "He is in a nursing home."]) {
    assert.equal(isHighImpactPersonalFact(claim(content)), true, content);
  }
});

test("isHighImpactPersonalFact flags high-impact tags even when the text is bland", () => {
  assert.equal(
    isHighImpactPersonalFact(claim("The date is June 3rd.", ["Family"])),
    true,
    "tag matching is case-insensitive",
  );
  assert.equal(isHighImpactPersonalFact(claim("The date is June 3rd.", [" medical "])), true);
});

test("isHighImpactPersonalFact leaves ordinary content alone", () => {
  for (const content of [
    "The team uses PostgreSQL for the primary store.",
    "Deploys run every Thursday at 9am.",
    "The build cache lives under the workspace root.",
    // Technical and business speech an earlier term list mis-flagged
    // (review round 1): bare kinship-adjacent words are not personal.
    "The child process inherits the parent environment.",
    "Render the sibling node before the parent component.",
    "Customer engagement rose after the launch.",
    "The partner integration ships next quarter.",
    "This is one of a family of retry strategies.",
  ]) {
    assert.equal(isHighImpactPersonalFact(claim(content, ["tools"])), false, content);
  }
});

test("isHighImpactPersonalFact flags the same kinship words once someone possesses them", () => {
  for (const content of [
    "His child starts school in September.",
    "Rachel's parents are visiting next week.",
    "Their family moved to Lisbon.",
  ]) {
    assert.equal(isHighImpactPersonalFact(claim(content)), true, content);
  }
});

function factOf(content: string, confidence: number, tags: string[] = []): ExtractedFact {
  return { category: "fact", content, confidence, tags };
}

test("clampAmbientCaptureConfidence lowers only high-impact facts above the ceiling", () => {
  const result: ExtractionResult = {
    facts: [
      factOf("Rachel's mother has a birthday on June 3rd.", 0.95),
      factOf("The team uses PostgreSQL.", 0.95, ["tools"]),
      factOf("His diagnosis was confirmed.", 0.2),
    ],
    profileUpdates: [],
    entities: [],
    questions: [],
  };

  const clamped = clampAmbientCaptureConfidence(result);

  assert.equal(clamped.facts[0]?.confidence, SPECULATIVE_CONFIDENCE_CEILING);
  assert.equal(clamped.facts[1]?.confidence, 0.95, "ordinary facts are untouched");
  assert.equal(clamped.facts[2]?.confidence, 0.2, "already-speculative facts are not raised");
});

test("clampAmbientCaptureConfidence returns the input untouched when nothing qualifies", () => {
  const result: ExtractionResult = {
    facts: [factOf("The team uses PostgreSQL.", 0.95, ["tools"])],
    profileUpdates: [],
    entities: [],
    questions: [],
  };

  assert.equal(clampAmbientCaptureConfidence(result), result, "no reallocation on the common path");
});

/**
 * Clamping extraction confidence is not enough on its own: at the default
 * thresholds, 0.39 x 0.8 sourceTrust plus a judge accept (+0.15), cross-source
 * corroboration (+0.15), and an existing supporting memory (+0.10) reaches
 * 0.712 — past the 0.7 auto-approve line. Two devices in one room recording
 * the same television program corroborate each other perfectly, so the wearable
 * pass caps a high-impact ambient candidate at the review queue.
 */
const DEFAULT_THRESHOLDS = { autoApproveTrust: 0.7, reviewTrust: 0.45 };

test("a fully-boosted high-impact ambient candidate stops at review, never active", () => {
  const boosted = 0.39 * 0.8 + 0.15 + 0.15 + 0.1;
  assert.ok(boosted > DEFAULT_THRESHOLDS.autoApproveTrust, "the boosts do clear auto-approve");

  const capped = decideSmart(boosted, "accept", DEFAULT_THRESHOLDS, { capAtReview: true });

  assert.equal(capped.outcome, "review");
  assert.equal(capped.reason, "ambient-high-impact");
  // The auto-approve comparison is inclusive, so the threshold itself must cap.
  assert.equal(
    decideSmart(DEFAULT_THRESHOLDS.autoApproveTrust, "accept", DEFAULT_THRESHOLDS, { capAtReview: true }).reason,
    "ambient-high-impact",
  );
});

test("the cap changes nothing for ordinary candidates or for drop/defer verdicts", () => {
  assert.equal(decideSmart(0.9, "accept", DEFAULT_THRESHOLDS).outcome, "active");
  assert.equal(decideSmart(0.5, undefined, DEFAULT_THRESHOLDS, { capAtReview: true }).reason, "queued-for-review");
  assert.equal(decideSmart(0.9, "reject", DEFAULT_THRESHOLDS, { capAtReview: true }).outcome, "drop");
  assert.equal(decideSmart(0.9, "defer", DEFAULT_THRESHOLDS, { capAtReview: true }).reason, "judge-deferred");
  assert.equal(decideSmart(0.2, undefined, DEFAULT_THRESHOLDS, { capAtReview: true }).outcome, "drop");
});

test("wearable extraction turns carry the ambient-capture flag", () => {
  const conversation: WearableConversation = {
    id: "conv-1",
    source: "fixture",
    startIso: "2026-08-02T12:00:00.000Z",
    endIso: "2026-08-02T12:10:00.000Z",
    segments: [
      {
        speakerKey: "0",
        text: "We should ship the release once the migration lands, and then review the rollout plan together.",
        startIso: "2026-08-02T12:00:00.000Z",
      },
    ],
  };
  const registry = emptySpeakerRegistry();

  const turns = buildExtractionTurns("fixture", "2026-08-02", conversation, registry);

  assert.ok(turns.length > 0, "the conversation is long enough to extract");
  for (const turn of turns) {
    assert.equal(turn.ambientCapture, true);
  }
});

/**
 * `BufferManager` validates a live turn against its `copyBufferTurn` snapshot
 * before extracting. If the copy dropped an explicit `ambientCapture: false`
 * while the comparison stayed strict, the two would never match and extraction
 * would be skipped for as long as that turn stayed buffered.
 */
test("copyBufferTurn round-trips both ambient-flag values and equality agrees", () => {
  for (const ambientCapture of [true, false, undefined]) {
    const turn: BufferTurn = {
      role: "user",
      content: "a buffered turn",
      timestamp: "2026-08-02T12:00:00.000Z",
      ...(ambientCapture === undefined ? {} : { ambientCapture }),
    };

    const copy = copyBufferTurn(turn);

    assert.equal(copy.ambientCapture, ambientCapture, `copy preserves ${String(ambientCapture)}`);
    assert.equal(bufferTurnsEqual(copy, turn), true, `snapshot matches for ${String(ambientCapture)}`);
  }
});

test("the meeting scribe prompt carries the ambient-audio rule", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes(AMBIENT_CAPTURE_PROMPT_RULE));
});
