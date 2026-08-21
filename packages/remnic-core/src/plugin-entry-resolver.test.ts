import test from "node:test";
import assert from "node:assert/strict";

import { resolvePluginEntry } from "./plugin-entry-resolver.js";

function resolve(raw: unknown): Record<string, unknown> | undefined {
  return resolvePluginEntry(raw, {
    candidateIds: ["openclaw-remnic", "openclaw-engram"],
    preferredId: "openclaw-remnic",
    getEntries(candidate) {
      const plugins = candidate["plugins"];
      if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
        return undefined;
      }
      const entries = (plugins as Record<string, unknown>)["entries"];
      return entries && typeof entries === "object" && !Array.isArray(entries)
        ? (entries as Record<string, unknown>)
        : undefined;
    },
    getSlotId(candidate) {
      const plugins = candidate["plugins"];
      if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
        return undefined;
      }
      const slots = (plugins as Record<string, unknown>)["slots"];
      if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
        return undefined;
      }
      const slotId = (slots as Record<string, unknown>)["memory"];
      return typeof slotId === "string" ? slotId : undefined;
    },
  });
}

test("resolvePluginEntry returns undefined for a foreign string memory slot", () => {
  const entry = resolve({
    plugins: {
      slots: { memory: "other-memory-plugin" },
      entries: {
        "openclaw-remnic": { config: { memoryDir: "/tmp/remnic" } },
        "openclaw-engram": { config: { memoryDir: "/tmp/engram" } },
      },
    },
  });

  assert.equal(entry, undefined);
});

test("resolvePluginEntry falls back to preferred id when memory slot is absent", () => {
  const entry = resolve({
    plugins: {
      entries: {
        "openclaw-remnic": { config: { memoryDir: "/tmp/remnic" } },
        "openclaw-engram": { config: { memoryDir: "/tmp/engram" } },
      },
    },
  });

  assert.deepEqual(entry, { config: { memoryDir: "/tmp/remnic" } });
});
