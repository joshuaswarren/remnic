import assert from "node:assert/strict";
import { test } from "node:test";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createFirefliesConnector,
  ensureFirefliesConnectorRegistered,
  resolveFirefliesApiKey,
  wearableConnectorRegistration,
} from "./index.js";

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return {
    enabled: true,
    memoryMode: "smart",
    sourceTrust: 0.85,
    autoApproveTrust: 0.7,
    reviewTrust: 0.45,
    minConfidence: 0,
    minImportance: "low",
    maxMemoriesPerDay: 0,
    importNativeMemories: "smart",
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
  assert.ok(getWearableConnector("fireflies"));
  assert.equal(ensureFirefliesConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, "fireflies");
});

test("resolveFirefliesApiKey prefers config, then REMNIC_*, then provider env", () => {
  assert.equal(resolveFirefliesApiKey("from-config", {}), "from-config");
  assert.equal(
    resolveFirefliesApiKey(undefined, {
      REMNIC_FIREFLIES_API_KEY: "remnic-env",
      FIREFLIES_API_KEY: "provider-env",
    }),
    "remnic-env",
  );
  assert.equal(
    resolveFirefliesApiKey(undefined, { FIREFLIES_API_KEY: "provider-env" }),
    "provider-env",
  );
  assert.equal(resolveFirefliesApiKey(undefined, {}), undefined);
  assert.equal(resolveFirefliesApiKey("   ", {}), undefined);
});

test("fetchConversations normalizes transcripts through the shared shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          transcripts: [
            {
              id: "m-1",
              title: "Weekly sync",
              date: Date.parse("2026-03-10T14:00:00.000Z"),
              duration: 15,
              sentences: [
                { speaker_name: "Jane", speaker_id: 0, text: "Hello", start_time: 1, end_time: 2 },
              ],
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const connector = createFirefliesConnector({
      settings: settings({ apiKey: "grn_test" }),
      timezone: "America/Chicago",
    });
    const page = await connector.fetchConversations({
      date: "2026-03-10",
      timezone: "America/Chicago",
    });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0]?.id, "m-1");
    assert.equal(page.conversations[0]?.source, "fireflies");
    assert.equal(page.conversations[0]?.segments[0]?.text, "Hello");
    // A single partial page ends the day.
    assert.equal(page.nextCursor, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchConversations advances the cursor across a full page", async () => {
  const originalFetch = globalThis.fetch;
  const full = Array.from({ length: 50 }, (_unused, i) => ({
    id: `m-${i}`,
    date: Date.parse("2026-03-10T14:00:00.000Z"),
    sentences: [{ text: "x", speaker_id: 0, start_time: 0, end_time: 1 }],
  }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { transcripts: full } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const connector = createFirefliesConnector({
      settings: settings({ apiKey: "grn_test" }),
      timezone: "UTC",
    });
    const page = await connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 50);
    assert.equal(page.nextCursor, "50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing API key surfaces an actionable error at call time, not construction", async () => {
  const connector = createFirefliesConnector({
    settings: settings({ apiKey: undefined }),
    timezone: "UTC",
  });
  // Construction did not throw; the call does, with the actionable message.
  await assert.rejects(
    connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /REMNIC_FIREFLIES_API_KEY/);
      return true;
    },
  );
});

test("a full page of id-less rows still advances the cursor by the raw count", async () => {
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 50 }, () => ({ noId: true, date: 0 }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { transcripts: rows } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const connector = createFirefliesConnector({ settings: settings({ apiKey: "grn" }), timezone: "UTC" });
    const page = await connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 0);
    assert.equal(page.nextCursor, "50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transcripts with no resolvable date are dropped, not emitted with an empty start", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          transcripts: [
            {
              id: "ok",
              date: Date.parse("2026-03-10T14:00:00.000Z"),
              sentences: [{ text: "hi", speaker_id: 0, start_time: 0, end_time: 1 }],
            },
            {
              id: "bad",
              date: "not-a-date",
              sentences: [{ text: "x", speaker_id: 0, start_time: 0, end_time: 1 }],
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const connector = createFirefliesConnector({ settings: settings({ apiKey: "grn" }), timezone: "UTC" });
    const page = await connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0]?.id, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
