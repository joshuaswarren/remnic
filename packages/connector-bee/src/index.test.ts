import assert from "node:assert/strict";
import { test } from "node:test";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createBeeConnector,
  ensureBeeConnectorRegistered,
  resolveBeeToken,
  wearableConnectorRegistration,
} from "./index.js";

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return {
    enabled: true,
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

/** Route-based global-fetch stub for connector-level tests. */
function stubFetch(routes: Record<string, unknown>): {
  restore: () => void;
  calls: string[];
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    for (const [prefix, payload] of Object.entries(routes)) {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        const body = typeof payload === "function" ? payload(url) : payload;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

test("importing the module registers the connector exactly once", () => {
  assert.ok(getWearableConnector("bee"));
  assert.equal(ensureBeeConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, "bee");
});

test("resolveBeeToken prefers config, then REMNIC_*, then provider env, else proxy mode", () => {
  assert.equal(resolveBeeToken("from-config", {}), "from-config");
  assert.equal(
    resolveBeeToken(undefined, {
      REMNIC_BEE_API_TOKEN: "remnic-env",
      BEE_API_TOKEN: "provider-env",
    }),
    "remnic-env",
  );
  assert.equal(resolveBeeToken(undefined, { BEE_API_TOKEN: "provider-env" }), "provider-env");
  assert.equal(resolveBeeToken(undefined, {}), undefined);
});

test("fetchConversations filters to the requested local day and fetches details", async () => {
  // 2026-06-10 in America/Chicago spans 05:00Z (Jun 10) to 05:00Z (Jun 11).
  const inDayMs = Date.UTC(2026, 5, 10, 20, 0, 0); // 15:00 Chicago, Jun 10
  const utcNextDayMs = Date.UTC(2026, 5, 11, 1, 0, 0); // 20:00 Chicago, Jun 10 — still in day!
  const olderMs = Date.UTC(2026, 5, 9, 12, 0, 0); // Jun 9 — older day
  const stub = stubFetch({
    "/v1/conversations": (url: URL) => {
      if (/^\/v1\/conversations\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/").pop());
        const startTime = id === 1 ? inDayMs : id === 2 ? utcNextDayMs : olderMs;
        return {
          id,
          start_time: startTime,
          transcriptions: [
            { utterances: [{ text: `utterance for ${id}`, speaker: "0", spoken_at: startTime }] },
          ],
        };
      }
      return {
        conversations: [
          { id: 1, start_time: inDayMs, state: "COMPLETED" },
          { id: 2, start_time: utcNextDayMs, state: "COMPLETED" },
          { id: 3, start_time: olderMs, state: "COMPLETED" },
          { id: 4, start_time: inDayMs, state: "CAPTURING" },
        ],
        next_cursor: "deeper",
      };
    },
  });
  try {
    const connector = createBeeConnector({ settings: settings(), timezone: "America/Chicago" });
    const page = await connector.fetchConversations({
      date: "2026-06-10",
      timezone: "America/Chicago",
    });
    // ids 1 and 2 are both Jun 10 in Chicago (2 crosses the UTC date
    // line); 3 is an older day; 4 is still capturing.
    assert.deepEqual(page.conversations.map((c) => c.id), ["1", "2"]);
    assert.equal(
      page.nextCursor,
      "deeper",
      "page still contained the target day — keep paginating",
    );
  } finally {
    stub.restore();
  }
});

test("pagination stops when an entire page predates the requested day", async () => {
  const olderMs = Date.UTC(2026, 5, 1, 12, 0, 0);
  const stub = stubFetch({
    "/v1/conversations": {
      conversations: [
        { id: 9, start_time: olderMs, state: "COMPLETED" },
        { id: 10, start_time: olderMs - 86_400_000, state: "COMPLETED" },
      ],
      next_cursor: "even-deeper",
    },
  });
  try {
    const connector = createBeeConnector({ settings: settings(), timezone: "UTC" });
    const page = await connector.fetchConversations({ date: "2026-06-10", timezone: "UTC" });
    assert.equal(page.conversations.length, 0);
    assert.equal(page.nextCursor, null, "all-older page must stop pagination");
  } finally {
    stub.restore();
  }
});

test("the proxy path never attaches an environment token", async () => {
  const previousRemnic = process.env.REMNIC_BEE_API_TOKEN;
  const previousProvider = process.env.BEE_API_TOKEN;
  process.env.BEE_API_TOKEN = "direct-mode-token";
  const original = globalThis.fetch;
  const headersSeen: Array<Record<string, string>> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    headersSeen.push(
      Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    );
    return new Response(JSON.stringify({ conversations: [], next_cursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    // Default base URL (the local proxy): token must be omitted.
    const proxyConnector = createBeeConnector({ settings: settings({ apiKey: undefined }), timezone: "UTC" });
    await proxyConnector.fetchConversations({ date: "2026-06-10", timezone: "UTC" });
    assert.equal(headersSeen[0].Authorization, undefined);

    // Direct base URL: the env token applies.
    const directConnector = createBeeConnector({
      settings: settings({ apiKey: undefined, baseUrl: "https://bee.example.test" }),
      timezone: "UTC",
    });
    await directConnector.fetchConversations({ date: "2026-06-10", timezone: "UTC" });
    assert.equal(headersSeen[1].Authorization, "Bearer direct-mode-token");
  } finally {
    globalThis.fetch = original;
    if (previousProvider !== undefined) process.env.BEE_API_TOKEN = previousProvider;
    else delete process.env.BEE_API_TOKEN;
    if (previousRemnic !== undefined) process.env.REMNIC_BEE_API_TOKEN = previousRemnic;
    else delete process.env.REMNIC_BEE_API_TOKEN;
  }
});

test("fetchNativeMemories maps Bee facts", async () => {
  const stub = stubFetch({
    "/v1/facts": {
      facts: [{ id: 5, text: "User likes tea.", created_at: Date.UTC(2026, 5, 1) }],
      next_cursor: null,
    },
  });
  try {
    const connector = createBeeConnector({ settings: settings(), timezone: "UTC" });
    assert.ok(connector.fetchNativeMemories, "bee connector must support native memories");
    const page = await connector.fetchNativeMemories({});
    assert.equal(page.memories.length, 1);
    assert.equal(page.memories[0].id, "5");
    assert.equal(page.nextCursor, null);
  } finally {
    stub.restore();
  }
});
