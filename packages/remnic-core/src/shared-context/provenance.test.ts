import assert from "node:assert/strict";
import { test } from "node:test";

import { stampProvenance } from "./provenance.js";

const AT = "2026-08-18T12:00:00.000Z";

test("stampProvenance stamps actor and at onto a new object", () => {
  const item = { id: "item-1", title: "note" };
  assert.deepEqual(stampProvenance(item, { actor: "agent-a", at: AT }), {
    id: "item-1",
    title: "note",
    provenance: { actor: "agent-a", at: AT },
  });
});

test("stampProvenance does not mutate the input item", () => {
  const item = { id: "item-1" };
  const stamped = stampProvenance(item, { actor: "agent-a", at: AT });
  assert.deepEqual(item, { id: "item-1" });
  assert.equal("provenance" in item, false);
  assert.notEqual(stamped, item);
});

test("stampProvenance rejects an empty actor and an invalid at", () => {
  const item = { id: "item-1" };
  const valid = { actor: "agent-a", at: AT };
  assert.throws(() => stampProvenance(item, { ...valid, actor: "" }), /actor/);
  assert.throws(() => stampProvenance(item, { ...valid, actor: "   " }), /actor/);
  assert.throws(() => stampProvenance(item, { ...valid, at: "not-a-date" }), /at/);
  assert.throws(
    () => stampProvenance(item, { ...valid, at: Number.NaN as unknown as string }),
    /at/,
  );
});
