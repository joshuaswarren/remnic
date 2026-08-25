import assert from "node:assert/strict";
import { test } from "node:test";
import { applySpanMode, extractionProviderJsonSchema } from "./extraction-span-wire.js";

const TEXT = "Alice moved to Seattle";

test("applySpanMode: disabled or 0 is identity", () => {
  const span = { text: TEXT, start: 6, end: 11 };
  assert.deepEqual(applySpanMode({ enabled: false, ...span }), { text: TEXT });
  assert.deepEqual(applySpanMode({ enabled: 0, ...span }), { text: TEXT });
  assert.deepEqual(applySpanMode(span), { text: TEXT });
});

test("applySpanMode: enabled slices half-open [start, end)", () => {
  assert.deepEqual(applySpanMode({ enabled: true, text: TEXT, start: 6, end: 11 }), {
    text: "moved",
    start: 6,
    end: 11,
  });
});

function factProperties(spanMode: "off" | "shadow" | "on") {
  const schema = extractionProviderJsonSchema(spanMode);
  const properties = schema.properties as
    | Record<string, { items?: { properties?: Record<string, unknown> } }>
    | undefined;
  return properties?.facts?.items?.properties ?? {};
}

test("provider schema omits span in off mode and keeps it in on/shadow (issue #2952)", () => {
  assert.equal("span" in factProperties("off"), false);
  assert.equal("span" in factProperties("on"), true);
  assert.equal("span" in factProperties("shadow"), true);
  assert.deepEqual(extractionProviderJsonSchema("on"), extractionProviderJsonSchema("shadow"));
  assert.notEqual(extractionProviderJsonSchema("off"), extractionProviderJsonSchema("on"));
});
