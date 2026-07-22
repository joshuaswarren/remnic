import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getWearableConnector } from "@remnic/core";
import type { WearableSourceSettings } from "@remnic/core";

import {
  createDesktopConnector,
  DESKTOP_SOURCE_ID,
  ensureDesktopConnectorRegistered,
  resolveDesktopBaseUrl,
  resolveDesktopToken,
  wearableConnectorRegistration,
} from "./connector.js";
import { DESKTOP_DEFAULT_BASE_URL } from "./http-client.js";

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return {
    enabled: true,
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

test("importing the module registers the desktop connector exactly once", () => {
  assert.ok(getWearableConnector(DESKTOP_SOURCE_ID));
  assert.equal(ensureDesktopConnectorRegistered(), false);
  assert.equal(wearableConnectorRegistration.id, DESKTOP_SOURCE_ID);
  assert.equal(wearableConnectorRegistration.id, "desktop");
});

test("resolveDesktopBaseUrl prefers explicit config over the loopback default", () => {
  assert.equal(resolveDesktopBaseUrl("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  assert.equal(resolveDesktopBaseUrl(undefined), DESKTOP_DEFAULT_BASE_URL);
  assert.equal(resolveDesktopBaseUrl("   "), DESKTOP_DEFAULT_BASE_URL);
});

test("resolveDesktopToken prefers config, then REMNIC_CAPTURE_AUDIO_TOKEN", () => {
  assert.equal(
    resolveDesktopToken("from-config", DESKTOP_DEFAULT_BASE_URL, {}),
    "from-config",
  );
  assert.equal(
    resolveDesktopToken(undefined, DESKTOP_DEFAULT_BASE_URL, {
      REMNIC_CAPTURE_AUDIO_TOKEN: "from-env",
    }),
    "from-env",
  );
});

test("resolveDesktopToken reads the token file for loopback but not for a remote host", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remnic-desktop-token-"));
  try {
    writeFileSync(path.join(dir, "token"), "file-token\n", { mode: 0o600 });
    const env = { REMNIC_CAPTURE_DIR: dir };
    // Loopback target: reading the on-disk token is safe.
    assert.equal(
      resolveDesktopToken(undefined, "http://127.0.0.1:4340", env),
      "file-token",
    );
    // Remote target: never leak the local token file to another host.
    assert.equal(
      resolveDesktopToken(undefined, "http://192.168.1.50:4340", env),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchConversations normalizes daemon conversations through the shared shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        conversations: [
          {
            id: "conv_1",
            startedAtUtc: "2026-06-10T14:00:00.000Z",
            endedAtUtc: "2026-06-10T14:05:00.000Z",
            state: "final",
            segmentCount: 1,
            segments: [
              {
                textRaw: "Hello desktop.",
                speakerKey: "cluster-1",
                isWearer: true,
                channel: "mic",
                startUtc: "2026-06-10T14:00:01.000Z",
                endUtc: "2026-06-10T14:00:03.000Z",
              },
            ],
          },
        ],
        nextCursor: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const connector = createDesktopConnector({ settings: settings(), timezone: "UTC" });
    const page = await connector.fetchConversations({
      date: "2026-06-10",
      timezone: "UTC",
    });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0].source, "desktop");
    assert.equal(page.conversations[0].segments[0].text, "Hello desktop.");
    assert.equal(page.conversations[0].segments[0].isWearer, true);
    assert.equal(page.nextCursor, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyAuth proxies the daemon health probe", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, version: "9.14.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const connector = createDesktopConnector({ settings: settings(), timezone: "UTC" });
    assert.deepEqual(await connector.verifyAuth(), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
