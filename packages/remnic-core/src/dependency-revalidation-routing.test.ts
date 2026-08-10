import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";

const superseded = { id: "support-old", content: "The service uses port 4000." };
const replacement = { id: "support-new", content: "The service uses port 5000." };
const dependents = [{ id: "dependent", category: "fact", content: "Port 4000 must be open." }];
const response = {
  content: JSON.stringify({
    verdicts: [{ memoryId: "dependent", verdict: "invalidated", reason: "The port changed." }],
  }),
};

function assertInvalidated(result: Awaited<ReturnType<ExtractionEngine["revalidateDependents"]>>): void {
  assert.deepEqual(result, {
    verdicts: [{ memoryId: "dependent", verdict: "invalidated", reason: "The port changed." }],
  });
}

test("revalidation preserves the direct Responses API route for the legacy constructor", async () => {
  const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
  let calls = 0;
  Reflect.set(engine, "client", {
    responses: {
      async create() {
        calls += 1;
        return { output_text: response.content };
      },
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents));
  assert.equal(calls, 1);
});

test("revalidation falls back to the direct route when the injected fast route is unavailable", async () => {
  const engine = new ExtractionEngine(
    parseConfig({ openaiApiKey: "fixture-key" }),
    undefined,
    undefined,
    undefined,
    undefined,
    async () => null,
  );
  let calls = 0;
  Reflect.set(engine, "client", {
    responses: {
      async create() {
        calls += 1;
        return { output_text: response.content };
      },
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents));
  assert.equal(calls, 1);
});

test("revalidation preserves the gateway fallback route for the legacy constructor", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  let calls = 0;
  Reflect.set(engine, "fallbackLlm", {
    async chatCompletion() {
      calls += 1;
      return response;
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents));
  assert.equal(calls, 1);
});
