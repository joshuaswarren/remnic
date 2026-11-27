import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildWriteIdempotencyPayload,
  composeMemoryEnvelope,
  FINGERPRINT_EXEMPT_FIELDS,
  WRITE_FINGERPRINT_FIELDS,
  type MemoryWriteInput,
} from "./write-envelope.js";


test("fingerprint payloads derive from the registry - a registry entry propagates without call-site edits", () => {
  const input: MemoryWriteInput = {
    content: "User prefers dark mode",
    category: "preference",
    tags: ["ui"],
    entityRef: "person-test",
    ttl: "2027-01-01T00:00:00.000Z",
    validAt: "2026-06-01T00:00:00.000Z",
    sourceConnector: "cli",
    structuredAttributes: { theme: "dark" },
    confidence: 0.9,
    sourceReason: "unit demo",
  };
  const envelope = composeMemoryEnvelope(input, { source: "extension-demo" });
  const payload = buildWriteIdempotencyPayload(envelope, { surface: "memory_store" });
  const fields = payload.fields;
  assert.ok(fields && typeof fields === "object" && !Array.isArray(fields), "payload carries a fields map");
  const fieldNames = Object.keys(fields);

  for (const field of WRITE_FINGERPRINT_FIELDS) {
    assert.ok(fieldNames.includes(field), `registry field ${field} missing from payload`);
  }
  // REGISTRY - it has no hand-written field list to forget.
  for (const field of FINGERPRINT_EXEMPT_FIELDS) {
    assert.equal(fieldNames.includes(field), false, `exempt field ${field} leaked into the payload`);
  }
});

test("the registry is exhaustive by construction: source text carries the compile-time assertions", () => {
  // presence in the source: deleting them would silently re-open the
  // unclassified-field gap this series closed.
  const source = readFileSync(
    path.resolve(import.meta.dirname, "write-envelope.ts"),
    "utf8",
  );
  assert.match(
    source,
    /UnclassifiedField extends never \? true : never/,
    "the every-field-classified assertion must remain",
  );
  assert.match(
    source,
    /DoublyClassifiedField extends never \? true : never/,
    "the no-double-classification assertion must remain",
  );
  assert.match(
    source,
    /UncoveredAccessFingerprintField extends never\s*\?\s*true\s*:\s*never/,
    "the access-surface coverage assertion must remain",
  );
});

test("scope fields ride beside registry fields: a new surface names itself, not the fields", () => {
  const envelope = composeMemoryEnvelope(
    { content: "scoped demo", category: "fact" },
    { source: "extension-demo" },
  );
  const a = buildWriteIdempotencyPayload(envelope, { surface: "memory_store", namespace: "default" });
  const b = buildWriteIdempotencyPayload(envelope, { surface: "wearable-sync", namespace: "default" });
  assert.notDeepEqual(a, b, "different surfaces must mint different payloads");
  assert.deepEqual(a.fields, b.fields, "surface identity lives in scope, never in the field set");
});
