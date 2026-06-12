import assert from "node:assert/strict";
import { test } from "node:test";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createOmiConnector,
  ensureOmiConnectorRegistered,
  resolveOmiApiKey,
  wearableConnectorRegistration,
} from "./index.js";

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return {
    enabled: true,
    apiKey: "sk_synthetic_not_real",
    appId: "app-123",
    userId: "uid-456",
    memoryMode: "review",
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

function stubFetch(handler: (url: URL) => unknown): {
  restore: () => void;
  urls: URL[];
} {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    urls,
  };
}

test("importing the module registers the connector exactly once", () => {
  assert.ok(getWearableConnector("omi"));
  assert.equal(ensureOmiConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, "omi");
});

test("resolveOmiApiKey prefers config, then REMNIC_*, then provider env", () => {
  assert.equal(resolveOmiApiKey("from-config", {}), "from-config");
  assert.equal(
    resolveOmiApiKey(undefined, {
      REMNIC_OMI_API_KEY: "remnic-env",
      OMI_API_KEY: "provider-env",
    }),
    "remnic-env",
  );
  assert.equal(resolveOmiApiKey(undefined, { OMI_API_KEY: "provider-env" }), "provider-env");
  assert.equal(resolveOmiApiKey(undefined, {}), undefined);
});

test("fetchConversations applies timezone day bounds and maps cursors to offsets", async () => {
  const stub = stubFetch((url) => {
    assert.equal(url.searchParams.get("start_date"), "2026-06-10T00:00:00-05:00");
    assert.equal(url.searchParams.get("end_date"), "2026-06-11T00:00:00-05:00");
    return {
      conversations: [
        {
          id: "c1",
          started_at: "2026-06-10T15:00:00+00:00",
          transcript_segments: [
            { text: "Planning the launch.", speaker: "SPEAKER_00", is_user: true, start: 0, end: 4 },
          ],
        },
        { id: "c2", started_at: "2026-06-10T16:00:00+00:00", discarded: true },
      ],
    };
  });
  try {
    const connector = createOmiConnector({
      settings: settings(),
      timezone: "America/Chicago",
    });
    const page = await connector.fetchConversations({
      date: "2026-06-10",
      timezone: "America/Chicago",
      cursor: "200",
    });
    assert.deepEqual(page.conversations.map((c) => c.id), ["c1"], "discarded filtered");
    assert.equal(page.nextCursor, null, "partial page ends pagination");
    assert.equal(stub.urls[0].searchParams.get("offset"), "200");
  } finally {
    stub.restore();
  }
});

test("missing credentials surface actionable errors at call time, not construction", async () => {
  const connector = createOmiConnector({
    settings: settings({ apiKey: undefined, appId: undefined, userId: undefined }),
    timezone: "UTC",
  });
  const previousRemnic = process.env.REMNIC_OMI_API_KEY;
  const previousProvider = process.env.OMI_API_KEY;
  delete process.env.REMNIC_OMI_API_KEY;
  delete process.env.OMI_API_KEY;
  try {
    await assert.rejects(
      connector.fetchConversations({ date: "2026-06-10", timezone: "UTC" }),
      /OMI_API_KEY/,
    );
  } finally {
    if (previousRemnic !== undefined) process.env.REMNIC_OMI_API_KEY = previousRemnic;
    if (previousProvider !== undefined) process.env.OMI_API_KEY = previousProvider;
  }
});

test("fetchNativeMemories maps Omi memories and skips empty content", async () => {
  const stub = stubFetch(() => ({
    memories: [
      { id: "m1", content: "User runs on Saturdays." },
      { id: "m2", content: "" },
    ],
  }));
  try {
    const connector = createOmiConnector({ settings: settings(), timezone: "UTC" });
    assert.ok(connector.fetchNativeMemories, "omi connector must support native memories");
    const page = await connector.fetchNativeMemories({});
    assert.deepEqual(page.memories.map((memory) => memory.id), ["m1"]);
    assert.equal(page.nextCursor, null);
  } finally {
    stub.restore();
  }
});
