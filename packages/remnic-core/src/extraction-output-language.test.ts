import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { CLUSTER_PROMPT } from "./calibration.js";
import { ExtractionEngine } from "./extraction.js";
import { JUDGE_SYSTEM_PROMPT } from "./extraction-judge.js";
import {
  OUTPUT_LANGUAGE_POLICY,
  buildConsolidationSystemPrompt,
  buildExtractionInstructions,
  buildProfileConsolidationSystemPrompt,
} from "./extraction-prompt.js";
import type { BufferTurn } from "./types.js";

// Issue #2190: prompts that produce memory content must embed the
// output-language policy so a non-English conversation is not silently
// translated to English — translated memories fail later lexical recall.
const ENGLISH_OUTPUT_DIRECTIVE_RE =
  /\b(?:write|respond|answer|output|produce|always reply)[^.]{0,60}\bin English\b/i;

// Japanese fixture: a non-English conversation that must stay Japanese.
const JAPANESE_TURNS: BufferTurn[] = [
  { role: "user", content: "私は毎朝緑茶を飲みます。", timestamp: "2026-08-17T01:00:00.000Z" },
  { role: "assistant", content: "承知しました。", timestamp: "2026-08-17T01:00:05.000Z" },
];

function allInstructionPrompts(): string[] {
  const config = parseConfig({});
  return [
    buildExtractionInstructions(config),
    buildConsolidationSystemPrompt(config),
    buildProfileConsolidationSystemPrompt(50),
    JUDGE_SYSTEM_PROMPT,
    CLUSTER_PROMPT,
  ];
}

test("extraction, consolidation, and profile-consolidation prompts embed the output-language policy", () => {
  const config = parseConfig({});
  assert.ok(
    buildExtractionInstructions(config).includes(OUTPUT_LANGUAGE_POLICY),
    "extraction instructions missing policy",
  );
  assert.ok(
    buildConsolidationSystemPrompt(config).includes(OUTPUT_LANGUAGE_POLICY),
    "consolidation prompt missing policy",
  );
  assert.ok(
    buildProfileConsolidationSystemPrompt(50).includes(OUTPUT_LANGUAGE_POLICY),
    "profile-consolidation prompt missing policy",
  );
});

test("judge and calibration prompts embed the output-language policy", () => {
  assert.ok(JUDGE_SYSTEM_PROMPT.includes(OUTPUT_LANGUAGE_POLICY), "judge prompt missing policy");
  assert.ok(CLUSTER_PROMPT.includes(OUTPUT_LANGUAGE_POLICY), "calibration prompt missing policy");
});

test("no prompt surface instructs English output", () => {
  for (const prompt of allInstructionPrompts()) {
    assert.doesNotMatch(prompt, ENGLISH_OUTPUT_DIRECTIVE_RE);
  }
});

test("local extraction of a Japanese conversation keeps the source language and is not told to emit English", async () => {
  const engine = new ExtractionEngine(
    parseConfig({
      localLlmEnabled: true,
      localLlmModel: "fixture-local",
      localLlmFallback: false,
    }),
  );
  let capturedPrompt = "";
  const localLlm = {
    async chatCompletion(messages: { content: string }[]) {
      capturedPrompt = messages.map((m) => m.content).join("\n");
      return {
        content: JSON.stringify({
          facts: [],
          profileUpdates: [],
          entities: [],
          questions: [],
          relationships: [],
        }),
      };
    },
  };
  const modelRegistry = {
    calculateContextSizes: () => ({
      maxInputChars: 8_000,
      maxOutputTokens: 1_000,
      description: "fixture",
    }),
  };
  assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);

  await engine.extract(JAPANESE_TURNS);

  assert.ok(capturedPrompt.length > 0, "no prompt captured from local extraction");
  assert.ok(
    capturedPrompt.includes(OUTPUT_LANGUAGE_POLICY),
    "local extraction prompt missing policy",
  );
  assert.ok(capturedPrompt.includes("私は毎朝緑茶を飲みます。"), "Japanese source not in prompt");
  assert.doesNotMatch(capturedPrompt, ENGLISH_OUTPUT_DIRECTIVE_RE);
});
