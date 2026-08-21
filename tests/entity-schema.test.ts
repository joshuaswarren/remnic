import test from "node:test";
import assert from "node:assert/strict";
import {
  getEntitySchema,
  normalizeEntitySchemas,
  resolveRequestedEntitySectionKeys,
} from "../packages/remnic-core/src/entity-schema.js";

test("getEntitySchema merges partial overrides onto default sections", () => {
  const entitySchemas = normalizeEntitySchemas({
    person: {
      sections: [
        { key: "beliefs", title: "Core Beliefs", aliases: ["values"] },
        { key: "voice", title: "Voice" },
      ],
    },
  });

  const schema = getEntitySchema("person", entitySchemas);

  assert.ok(schema);
  assert.deepEqual(schema.sections.map((section) => section.key), [
    "beliefs",
    "communication_style",
    "building",
    "voice",
  ]);
  assert.equal(schema.sections[0]?.title, "Core Beliefs");
  assert.deepEqual(schema.sections[0]?.aliases, ["belief", "beliefs", "believe", "believes", "values"]);
});

test("resolveRequestedEntitySectionKeys still matches default aliases under partial overrides", () => {
  const entitySchemas = normalizeEntitySchemas({
    person: {
      sections: [
        { key: "beliefs", title: "Core Beliefs" },
      ],
    },
  });

  const requested = resolveRequestedEntitySectionKeys(
    "How do they communicate?",
    "person",
    [
      {
        key: "communication_style",
        title: "Communication Style",
        facts: ["Prefers concise written updates."],
      },
    ],
    entitySchemas,
  );

  assert.deepEqual(requested, ["communication_style"]);
});

test("resolveRequestedEntitySectionKeys preserves default aliases on overridden sections", () => {
  const entitySchemas = normalizeEntitySchemas({
    person: {
      sections: [
        { key: "beliefs", title: "Core Beliefs" },
      ],
    },
  });

  const requested = resolveRequestedEntitySectionKeys(
    "What does Alice believe?",
    "person",
    [
      {
        key: "beliefs",
        title: "Core Beliefs",
        facts: ["Believes careful migrations beat rushed rewrites."],
      },
    ],
    entitySchemas,
  );

  assert.deepEqual(requested, ["beliefs"]);
});
