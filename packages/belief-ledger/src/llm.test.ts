import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FallbackLlmClient } from "@remnic/core";

import { createFallbackLlmLedgerAdapter } from "./llm.js";
import type { LedgerClaim } from "./types.js";

describe("Fallback LLM ledger adapter", () => {
  it("includes claim time windows in judge prompts", async () => {
    let userPrompt = "";
    const client = {
      async parseWithSchema(messages: unknown, schema: { parse(data: unknown): unknown }): Promise<unknown> {
        const sentMessages = messages as Array<{ role: string; content: string }>;
        userPrompt = sentMessages.find((message) => message.role === "user")?.content ?? "";
        return schema.parse({
          classification: "unrelated",
          confidence: 0.8,
          rationale: "The claims are scoped to different periods.",
        });
      },
    } as unknown as FallbackLlmClient;
    const adapter = createFallbackLlmLedgerAdapter(client);

    await adapter.judgeClaimPair({
      current: makePromptClaim("current", {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-03-31T23:59:59.000Z",
      }),
      prior: makePromptClaim("prior", {
        start: "2025-01-01T00:00:00.000Z",
        end: "2025-12-31T23:59:59.000Z",
      }),
    });

    assert.match(userPrompt, /timeWindow\.start: 2026-01-01T00:00:00\.000Z/);
    assert.match(userPrompt, /timeWindow\.end: 2026-03-31T23:59:59\.000Z/);
    assert.match(userPrompt, /timeWindow\.start: 2025-01-01T00:00:00\.000Z/);
    assert.match(userPrompt, /timeWindow\.end: 2025-12-31T23:59:59\.000Z/);
  });
});

function makePromptClaim(id: string, timeWindow: NonNullable<LedgerClaim["scope"]["timeWindow"]>): LedgerClaim {
  return {
    id,
    memoryId: id,
    statement: "Remote work improved output.",
    kind: "claim",
    stance: "for",
    confidence: 0.7,
    scope: { entities: ["Remote Work"], domain: "work", timeWindow },
    evidenceLinks: [],
    status: "active",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    parentIds: [],
  };
}
