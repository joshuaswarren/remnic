import assert from "node:assert/strict";
import test from "node:test";

import { stripSessionOwnedSchemaFields } from "./index.js";

test("stripSessionOwnedSchemaFields hides session routing fields from Pi tools", () => {
  const schema = stripSessionOwnedSchemaFields({
    type: "object",
    properties: {
      sessionKey: { type: "string" },
      namespace: { type: "string" },
      cwd: { type: "string" },
      query: { type: "string" },
    },
    required: ["sessionKey", "query"],
    additionalProperties: false,
  });

  assert.deepEqual(schema.properties, {
    query: { type: "string" },
  });
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.additionalProperties, false);
});
