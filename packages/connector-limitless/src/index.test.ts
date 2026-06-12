import assert from "node:assert/strict";
import { test } from "node:test";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createLimitlessConnector,
  ensureLimitlessConnectorRegistered,
  resolveLimitlessApiKey,
  wearableConnectorRegistration,
} from "./index.js";

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return {
    enabled: true,
    apiKey: "config-key",
    memoryMode: "review",
    sourceTrust: 0.8,
    autoApproveTrust: 0.7,
    reviewTrust: 0.45,
    minConfidence: 0.6,
    minImportance: "low",
    maxMemoriesPerDay: 20,
    importNativeMemories: "off",
    cleanup: {
      mergeSameSpeaker: true,
      stripFillers: true,
      collapseRepeats: true,
      dropLowQuality: true,
    },
    ...overrides,
  };
}

test("importing the module registers the connector exactly once", () => {
  // The import at the top of this file already registered it.
  assert.ok(getWearableConnector("limitless"));
  assert.equal(ensureLimitlessConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, "limitless");
});

test("resolveLimitlessApiKey prefers config, then REMNIC_*, then provider env", () => {
  assert.equal(resolveLimitlessApiKey("from-config", {}), "from-config");
  assert.equal(
    resolveLimitlessApiKey(undefined, {
      REMNIC_LIMITLESS_API_KEY: "remnic-env",
      LIMITLESS_API_KEY: "provider-env",
    }),
    "remnic-env",
  );
  assert.equal(
    resolveLimitlessApiKey(undefined, { LIMITLESS_API_KEY: "provider-env" }),
    "provider-env",
  );
  assert.equal(resolveLimitlessApiKey(undefined, {}), undefined);
  assert.equal(resolveLimitlessApiKey("   ", {}), undefined);
});

test("fetchConversations normalizes lifelogs through the shared shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          lifelogs: [
            {
              id: "lifelog-9",
              title: "Walk",
              startTime: "2026-06-10T08:00:00Z",
              endTime: "2026-06-10T08:20:00Z",
              contents: [
                {
                  type: "blockquote",
                  content: "Let's plan the trip for August.",
                  speakerName: "Sam Sample",
                  speakerIdentifier: "user",
                },
              ],
            },
          ],
        },
        meta: { lifelogs: { nextCursor: "next-1", count: 1 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const connector = createLimitlessConnector({
      settings: settings(),
      timezone: "UTC",
    });
    const page = await connector.fetchConversations({
      date: "2026-06-10",
      timezone: "UTC",
    });
    assert.equal(page.nextCursor, "next-1");
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0].source, "limitless");
    assert.equal(page.conversations[0].segments[0].isWearer, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing API key surfaces an actionable error at call time, not construction", async () => {
  const connector = createLimitlessConnector({
    settings: settings({ apiKey: undefined }),
    timezone: "UTC",
  });
  const previousRemnic = process.env.REMNIC_LIMITLESS_API_KEY;
  const previousProvider = process.env.LIMITLESS_API_KEY;
  delete process.env.REMNIC_LIMITLESS_API_KEY;
  delete process.env.LIMITLESS_API_KEY;
  try {
    await assert.rejects(
      connector.fetchConversations({ date: "2026-06-10", timezone: "UTC" }),
      /LIMITLESS_API_KEY/,
    );
  } finally {
    if (previousRemnic !== undefined) process.env.REMNIC_LIMITLESS_API_KEY = previousRemnic;
    if (previousProvider !== undefined) process.env.LIMITLESS_API_KEY = previousProvider;
  }
});
