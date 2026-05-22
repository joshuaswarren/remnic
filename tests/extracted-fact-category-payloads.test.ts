import assert from "node:assert/strict";
import test from "node:test";

import { ExtractedFactSchema } from "../packages/remnic-core/src/schemas.js";

test("ExtractedFactSchema rejects procedure facts without at least two steps", () => {
  const missing = ExtractedFactSchema.safeParse({
    category: "procedure",
    content: "When deploying, follow the release checklist.",
    confidence: 0.9,
    tags: ["procedure"],
  });
  assert.equal(missing.success, false);

  const oneStep = ExtractedFactSchema.safeParse({
    category: "procedure",
    content: "When deploying, follow the release checklist.",
    confidence: 0.9,
    tags: ["procedure"],
    procedureSteps: [
      { order: 1, intent: "Run the smoke test." },
    ],
  });
  assert.equal(oneStep.success, false);
});

test("ExtractedFactSchema accepts procedure facts with at least two steps", () => {
  const parsed = ExtractedFactSchema.safeParse({
    category: "procedure",
    content: "When deploying, run checks before publishing.",
    confidence: 0.9,
    tags: ["procedure"],
    procedureSteps: [
      { order: 1, intent: "Run the smoke test." },
      { order: 2, intent: "Publish only after the smoke test passes." },
    ],
  });

  assert.equal(parsed.success, true);
});

test("ExtractedFactSchema accepts reasoning_trace payloads with snake_case aliases", () => {
  const parsed = ExtractedFactSchema.safeParse({
    category: "reasoning_trace",
    content: "The solution path for the incident was recorded.",
    confidence: 0.9,
    tags: ["reasoning"],
    reasoningTrace: {
      steps: [
        { order: 1, description: "Checked the failing health signal." },
        { order: 2, description: "Traced it to a stale config path." },
      ],
      final_answer: "The stale config path caused the failure.",
      observed_outcome: "Updating the path resolved the health check.",
    },
  });

  assert.equal(parsed.success, true);
});
