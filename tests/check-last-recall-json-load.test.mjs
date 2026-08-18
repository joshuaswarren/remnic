import assert from "node:assert/strict";
import { test } from "node:test";
import { findLastRecallLoadHoles } from "../scripts/check-last-recall-json-load.mjs";

test("flags a load() that accepts any JSON object", () => {
  const holes = findLastRecallLoadHoles(`
    async load(): Promise<void> {
      const parsed = JSON.parse(raw) as LastRecallState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    }
  `);
  assert.ok(holes.includes("load() must reject JSON arrays"));
  assert.ok(holes.includes("load() must skip unsafe session keys"));
});

test("accepts the hardened load() shape", () => {
  const holes = findLastRecallLoadHoles(`
    async load(): Promise<void> {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.state = {};
        return;
      }
      for (const [sessionKey, snapshot] of Object.entries(parsed)) {
        if (isUnsafeStateKey(sessionKey)) continue;
      }
    }
  `);
  assert.deepEqual(holes, []);
});
