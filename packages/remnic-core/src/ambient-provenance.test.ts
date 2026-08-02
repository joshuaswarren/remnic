import assert from "node:assert/strict";
import test from "node:test";

import {
  AMBIENT_CAPTURE_PROMPT_RULE,
  SPECULATIVE_CONFIDENCE_CEILING,
  clampAmbientCaptureConfidence,
  isHighImpactPersonalFact,
} from "./ambient-provenance.js";
import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import { SUMMARY_SYSTEM_PROMPT } from "./meetings/summary-extractor.js";
import { emptySpeakerRegistry } from "./wearables/speakers.js";
import { buildExtractionTurns } from "./wearables/memory-gen.js";
import type { WearableConversation } from "./wearables/types.js";
import type { BufferTurn, ExtractedFact, ExtractionResult } from "./types.js";

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
    async chatCompletion(messages: ChatMessage[]) {
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
    async parseWithSchemaDetailed(messages: ChatMessage[]) {
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
        async create(request: { messages: ChatMessage[] }) {
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

test("ordinary ambient facts keep their confidence — only high-impact classes clamp", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  const line = "The team uses PostgreSQL for the primary store.";
  const fallbackLlm = {
    async parseWithSchemaDetailed() {
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

test("isHighImpactPersonalFact flags family, milestone, and medical content", () => {
  for (const content of [
    "Rachel's mother has a birthday on June 3rd.",
    "Their wedding anniversary is in October.",
    "He was diagnosed with diabetes last spring.",
    "Her surgery is scheduled for Tuesday.",
    "The funeral is on Saturday.",
  ]) {
    assert.equal(isHighImpactPersonalFact({ content, tags: [] }), true, content);
  }
});

test("isHighImpactPersonalFact flags high-impact tags even when the text is bland", () => {
  assert.equal(
    isHighImpactPersonalFact({ content: "The date is June 3rd.", tags: ["Family"] }),
    true,
    "tag matching is case-insensitive",
  );
  assert.equal(isHighImpactPersonalFact({ content: "The date is June 3rd.", tags: [" medical "] }), true);
});

test("isHighImpactPersonalFact leaves ordinary content alone", () => {
  for (const content of [
    "The team uses PostgreSQL for the primary store.",
    "Deploys run every Thursday at 9am.",
    "The build cache lives under the workspace root.",
  ]) {
    assert.equal(isHighImpactPersonalFact({ content, tags: ["tools"] }), false, content);
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

test("the meeting scribe prompt carries the ambient-audio rule", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes(AMBIENT_CAPTURE_PROMPT_RULE));
});
