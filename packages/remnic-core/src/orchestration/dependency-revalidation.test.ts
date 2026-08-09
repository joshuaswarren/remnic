import assert from "node:assert/strict";
import test from "node:test";

import {
  revalidateDependentsViaLlm,
  type RevalidationDeps,
} from "./dependency-revalidation.js";

type Dependent = { id: string; category: string; content: string };
type CompletionOptions = {
  operation?: string;
  priority?: "background" | "recall-critical";
  timeoutMs?: number;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
};

type CompletionCall = {
  messages: Array<{ role: string; content: string }>;
  options: CompletionOptions;
};

const superseded = { id: "old", content: "old supporting fact" };
const replacement = { id: "new", content: "new supporting fact" };

function dependents(count: number): Dependent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `dependent-${String(index + 1).padStart(2, "0")}`,
    category: index % 2 === 0 ? "fact" : "decision",
    content: `dependent claim ${index + 1}`,
  }));
}

function makeDeps(payload: unknown, calls: CompletionCall[]): RevalidationDeps {
  return {
    fastChatCompletion: async (messages, options) => {
      calls.push({ messages, options });
      return { content: JSON.stringify(payload) };
    },
    parseJsonObject: (raw) => JSON.parse(raw ?? "null") as unknown,
  };
}

test("revalidation uses only the injected fast completion seam", async () => {
  const calls: CompletionCall[] = [];
  const signal = new AbortController().signal;
  const requested = dependents(1);

  await revalidateDependentsViaLlm(
    makeDeps({ verdicts: [{ memoryId: requested[0]!.id, verdict: "still_valid" }] }, calls),
    superseded,
    replacement,
    requested,
    { signal, timeoutMs: 37 },
  );

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.options.operation, "dependency_revalidation");
  assert.equal(call.options.priority, "background");
  assert.equal(call.options.timeoutMs, 37);
  assert.equal(call.options.signal, signal);
});

test("revalidation normalizes one verdict per dependent for one, five, and ten dependents", async () => {
  for (const count of [1, 5, 10]) {
    const requested = dependents(count);
    const calls: CompletionCall[] = [];
    const result = await revalidateDependentsViaLlm(
      makeDeps(
        {
          verdicts: [
            ...requested.map((dependent) => ({ memoryId: dependent.id, verdict: "invalidated" })),
            { memoryId: "unknown-id", verdict: "invalidated" },
            { memoryId: requested[0]!.id, verdict: "still_valid" },
          ],
        },
        calls,
      ),
      superseded,
      replacement,
      requested,
      { timeoutMs: 37 },
    );

    assert.equal(result.verdicts.length, count);
    assert.deepEqual(
      result.verdicts.map((verdict) => verdict.memoryId),
      requested.map((dependent) => dependent.id),
    );
    assert.equal(new Set(result.verdicts.map((verdict) => verdict.memoryId)).size, count);
    assert.equal(calls.length, 1);
  }
});
