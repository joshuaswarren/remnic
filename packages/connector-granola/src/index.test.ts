import assert from "node:assert/strict";
import { test } from "node:test";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createGranolaConnector,
  ensureGranolaConnectorRegistered,
  resolveGranolaApiKey,
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

/** Route a mocked fetch by URL: list vs single-note-detail. */
function mockGranola(notes: Record<string, unknown>, detailByPath: Record<string, { body: unknown; status?: number }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const detailMatch = u.match(/\/v1\/notes\/([^?]+)\?include=transcript/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1] ?? "");
      const entry = detailByPath[id];
      const status = entry?.status ?? (entry ? 200 : 404);
      return new Response(JSON.stringify(entry?.body ?? { error: "not found" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(notes), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("importing the module registers the connector exactly once", () => {
  assert.ok(getWearableConnector("granola"));
  assert.equal(ensureGranolaConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, "granola");
});

test("resolveGranolaApiKey prefers config, then REMNIC_*, then provider env", () => {
  assert.equal(resolveGranolaApiKey("from-config", {}), "from-config");
  assert.equal(
    resolveGranolaApiKey(undefined, { REMNIC_GRANOLA_API_KEY: "remnic-env", GRANOLA_API_KEY: "provider-env" }),
    "remnic-env",
  );
  assert.equal(resolveGranolaApiKey(undefined, { GRANOLA_API_KEY: "provider-env" }), "provider-env");
  assert.equal(resolveGranolaApiKey(undefined, {}), undefined);
});

test("fetchConversations lists notes then fetches each transcript", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGranola(
    { notes: [{ id: "not_a" }, { id: "not_b" }], hasMore: true, cursor: "next" },
    {
      not_a: {
        body: {
          id: "not_a",
          calendar_event: { event_title: "A", scheduled_start_time: "2026-03-10T14:00:00.000Z" },
          transcript: [{ speaker: { source: "microphone" }, text: "hi", start_time: "2026-03-10T14:00:01.000Z", end_time: "2026-03-10T14:00:02.000Z" }],
        },
      },
      not_b: {
        body: {
          id: "not_b",
          calendar_event: { event_title: "B", scheduled_start_time: "2026-03-10T16:00:00.000Z" },
          summary_text: "note only",
          transcript: [],
        },
      },
    },
  );
  try {
    const connector = createGranolaConnector({ settings: settings({ apiKey: "grn_k" }), timezone: "UTC" });
    const page = await connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 2);
    assert.equal(page.conversations[0]?.id, "not_a");
    assert.equal(page.conversations[0]?.title, "A");
    assert.equal(page.conversations[1]?.segments[0]?.speakerKey, "note");
    assert.equal(page.nextCursor, "next");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a note that 404s on detail fetch is skipped, not fatal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGranola(
    { notes: [{ id: "not_a" }, { id: "not_gone" }], hasMore: false, cursor: null },
    {
      not_a: {
        body: {
          id: "not_a",
          calendar_event: { scheduled_start_time: "2026-03-10T14:00:00.000Z" },
          transcript: [{ speaker: { source: "speaker" }, text: "hi", start_time: "2026-03-10T14:00:01.000Z", end_time: "2026-03-10T14:00:02.000Z" }],
        },
      },
      // not_gone omitted → 404
    },
  );
  try {
    const connector = createGranolaConnector({ settings: settings({ apiKey: "grn_k" }), timezone: "UTC" });
    const page = await connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0]?.id, "not_a");
    assert.equal(page.nextCursor, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing API key surfaces an actionable error at call time, not construction", async () => {
  const connector = createGranolaConnector({ settings: settings({ apiKey: undefined }), timezone: "UTC" });
  await assert.rejects(
    connector.fetchConversations({ date: "2026-03-10", timezone: "UTC" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /REMNIC_GRANOLA_API_KEY/);
      return true;
    },
  );
});
