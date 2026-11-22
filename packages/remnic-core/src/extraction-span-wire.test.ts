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

// Providers receive this as the extraction response_format. zod 3 advertised
// additionalProperties:false on every object; the zod 4 port must too.
type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  additionalProperties?: boolean | SchemaNode;
};

function openObjectSchemas(node: SchemaNode, path: string, found: string[]): void {
  if (node.type === "object" && node.properties && node.additionalProperties !== false) found.push(path);
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    openObjectSchemas(child, `${path}.${name}`, found);
  }
  if (node.items) openObjectSchemas(node.items, `${path}[]`, found);
  node.anyOf?.forEach((child, index) => openObjectSchemas(child, `${path}|${index}`, found));
}

test("provider schema closes every object schema with additionalProperties false", () => {
  for (const mode of ["off", "on"] as const) {
    const open: string[] = [];
    // SAFETY: extractionProviderJsonSchema returns a JSON Schema document; SchemaNode names the keys walked here.
    openObjectSchemas(extractionProviderJsonSchema(mode) as SchemaNode, "$", open);
    assert.deepEqual(open, [], `spanMode=${mode}: objects that let a provider emit extra keys`);
  }
});
