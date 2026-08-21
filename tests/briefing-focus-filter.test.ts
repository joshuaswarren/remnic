import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBriefingFocus,
  focusMatchesMemory,
  focusMatchesEntity,
} from "../src/briefing.js";
import type { MemoryFile, EntityFile, BriefingFocus } from "../src/types.js";

// ──────────────────────────────────────────────────────────────────────────
// parseBriefingFocus
// ──────────────────────────────────────────────────────────────────────────

test("parseBriefingFocus recognizes typed prefixes", () => {
  assert.deepEqual(parseBriefingFocus("person:Jane Doe"), {
    type: "person",
    value: "Jane Doe",
  });
  assert.deepEqual(parseBriefingFocus("project:remnic-core"), {
    type: "project",
    value: "remnic-core",
  });
  assert.deepEqual(parseBriefingFocus("topic:retrieval"), {
    type: "topic",
    value: "retrieval",
  });
});

test("parseBriefingFocus defaults to topic for untyped values", () => {
  assert.deepEqual(parseBriefingFocus("retrieval"), {
    type: "topic",
    value: "retrieval",
  });
});

test("parseBriefingFocus preserves colons in the value", () => {
  assert.deepEqual(parseBriefingFocus("topic:product:launch"), {
    type: "topic",
    value: "product:launch",
  });
});

test("parseBriefingFocus handles unknown prefixes as topics", () => {
  assert.deepEqual(parseBriefingFocus("place:Toronto"), {
    type: "topic",
    value: "place:Toronto",
  });
});

test("parseBriefingFocus returns null for empty / non-string input", () => {
  assert.equal(parseBriefingFocus(undefined), null);
  assert.equal(parseBriefingFocus(""), null);
  assert.equal(parseBriefingFocus("   "), null);
  assert.equal(parseBriefingFocus("topic:"), null);
});

// ──────────────────────────────────────────────────────────────────────────
// focusMatchesMemory
// ──────────────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryFile["frontmatter"]>, content = ""): MemoryFile {
  return {
    path: "/tmp/facts/2026-04-11/fact-test.md",
    content,
    frontmatter: {
      id: "fact-test",
      category: "fact",
      created: "2026-04-11T12:00:00.000Z",
      updated: "2026-04-11T12:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "implied",
      tags: [],
      ...overrides,
    },
  };
}

test("focusMatchesMemory matches against content, tags, and entityRef", () => {
  const byContent = makeMemory({}, "Alpha team shipped the retrieval overhaul.");
  assert.equal(
    focusMatchesMemory(byContent, { type: "topic", value: "retrieval" }),
    true,
  );

  const byTag = makeMemory({ tags: ["topic:alpha", "pending"] }, "Unrelated body text.");
  assert.equal(
    focusMatchesMemory(byTag, { type: "topic", value: "alpha" }),
    true,
  );

  const byEntityRef = makeMemory({ entityRef: "project-remnic-core" }, "Design note.");
  assert.equal(
    focusMatchesMemory(byEntityRef, { type: "project", value: "remnic-core" }),
    true,
  );
});

test("focusMatchesMemory returns false when needle is absent", () => {
  const memory = makeMemory({ tags: ["topic:beta"] }, "Nothing matches here.");
  assert.equal(
    focusMatchesMemory(memory, { type: "topic", value: "alpha" }),
    false,
  );
});

test("focusMatchesMemory is case-insensitive", () => {
  const memory = makeMemory({}, "Retrieval Overhaul");
  assert.equal(
    focusMatchesMemory(memory, { type: "topic", value: "retrieval overhaul" }),
    true,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// focusMatchesEntity
// ──────────────────────────────────────────────────────────────────────────

function makeEntity(overrides: Partial<EntityFile>): EntityFile {
  return {
    name: "test-entity",
    type: "other",
    updated: "2026-04-11T12:00:00.000Z",
    facts: [],
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
    ...overrides,
  };
}

test("focusMatchesEntity enforces entity type for person / project focus", () => {
  const person = makeEntity({ name: "jane-doe", type: "person", facts: ["Leads team"] });
  const project = makeEntity({ name: "remnic-core", type: "project" });

  const personFocus: BriefingFocus = { type: "person", value: "jane" };
  const projectFocus: BriefingFocus = { type: "project", value: "remnic" };

  assert.equal(focusMatchesEntity(person, personFocus), true);
  assert.equal(focusMatchesEntity(project, personFocus), false, "project should not match person focus");
  assert.equal(focusMatchesEntity(project, projectFocus), true);
  assert.equal(focusMatchesEntity(person, projectFocus), false, "person should not match project focus");
});

test("focusMatchesEntity matches summary, facts, and aliases (topic focus)", () => {
  const entity = makeEntity({
    name: "alpha",
    type: "tool",
    summary: "Automates retrieval experiments",
    facts: ["Runs benchmark harness"],
    aliases: ["alpha-tool"],
  });

  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "retrieval" }),
    true,
    "summary should match topic focus",
  );
  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "harness" }),
    true,
    "facts should match topic focus",
  );
  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "alpha-tool" }),
    true,
    "aliases should match topic focus",
  );
  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "unrelated" }),
    false,
  );
});

test("focusMatchesEntity matches structured section titles and facts", () => {
  const entity = makeEntity({
    name: "alex",
    type: "person",
    structuredSections: [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: ["Small teams should own whole systems."],
      },
    ],
  });

  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "beliefs" }),
    true,
  );
  assert.equal(
    focusMatchesEntity(entity, { type: "topic", value: "whole systems" }),
    true,
  );
});
