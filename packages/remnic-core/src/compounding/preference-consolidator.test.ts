import test from "node:test";
import assert from "node:assert/strict";

import { consolidatePreferences } from "./preference-consolidator.js";
import type { MemoryFile } from "../types.js";

function memory(content: string): MemoryFile {
  return {
    path: "/synthetic.md",
    content,
    frontmatter: {
      id: `memory-${content}`,
      category: "fact",
      confidence: 0.8,
      status: "active",
      created: "2026-01-01T00:00:00.000Z",
    },
  } as MemoryFile;
}

test("consolidatePreferences preserves never-use facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user never uses Docker for deployments."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer Docker for deployments",
  );
});

test("consolidatePreferences preserves like facts as positive preferences", () => {
  const result = consolidatePreferences([
    memory("The user likes React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers React for dashboards",
  );
});

test("consolidatePreferences preserves like-to facts as infinitive preferences", () => {
  const result = consolidatePreferences([
    memory("The user would like to use React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers to use React for dashboards",
  );
});

test("consolidatePreferences does not join separate like-to follow-up sentences", () => {
  const result = consolidatePreferences([
    memory("The user would like to use React. They moved to Svelte."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0]?.statement, "The user prefers to use React");
});

test("consolidatePreferences preserves love facts as positive preferences", () => {
  const result = consolidatePreferences([
    memory("The user loves Svelte for prototypes."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers Svelte for prototypes",
  );
});

test("consolidatePreferences preserves does-not-love facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user does not love React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
});

test("consolidatePreferences preserves did-not-love facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
});

test("consolidatePreferences preserves would-not-love facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user would not love React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
});

test("consolidatePreferences preserves would-not-like-to facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user would not like to use React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer to use React for dashboards",
  );
});

test("consolidatePreferences preserves no-longer-loves facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user no longer loves React."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0]?.statement, "The user would not prefer React");
});

test("consolidatePreferences preserves disliked facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user disliked React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
});

test("consolidatePreferences ignores double-negated dislike facts", () => {
  const result = consolidatePreferences([
    memory("The user does not dislike React."),
  ]);

  assert.equal(result.preferences.length, 0);
});

test("consolidatePreferences ignores repeated double-negated dislike facts", () => {
  const result = consolidatePreferences([
    memory("The user does not dislike React and does not dislike Svelte."),
  ]);

  assert.equal(result.preferences.length, 0);
});

test("consolidatePreferences preserves explicit preferences after double-negated aversion", () => {
  const result = consolidatePreferences([
    memory("The user does not dislike React, but prefers Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers Svelte for dashboards",
  );
});

test("consolidatePreferences preserves replacement love clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React but now loves Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers Svelte for dashboards",
  );
});

test("consolidatePreferences preserves short replacement love clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React but now loves Go."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0]?.statement, "The user prefers Go");
});

test("consolidatePreferences preserves and-now replacement clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React, and now loves Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers Svelte for dashboards",
  );
});

test("consolidatePreferences preserves plain-and replacement clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React and loves Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers Svelte for dashboards",
  );
});

test("consolidatePreferences keeps compound negated-use clauses negative", () => {
  const result = consolidatePreferences([
    memory("The user does not use React and uses Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0]?.statement, "The user would not prefer React");
});

test("consolidatePreferences preserves replacement like-to clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React but like to use Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers to use Svelte for dashboards",
  );
});

test("consolidatePreferences preserves replacement enjoying clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React but enjoying Svelte dashboard work."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers: enjoying Svelte dashboard work",
  );
});

test("consolidatePreferences preserves replacement use clauses after withdrawn preferences", () => {
  const result = consolidatePreferences([
    memory("The user did not love React but now uses Svelte for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers to use Svelte for dashboards",
  );
});

test("consolidatePreferences still admits preference stem variants in facts", () => {
  const result = consolidatePreferences([
    memory("The user is enjoying Svelte specialization work."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user is enjoying Svelte specialization work",
  );
});

test("consolidatePreferences ignores like analogies in facts", () => {
  const result = consolidatePreferences([
    memory("The user said Next.js is like React."),
  ]);

  assert.equal(result.preferences.length, 0);
});

test("consolidatePreferences ignores stale past-tense liked facts", () => {
  const result = consolidatePreferences([
    memory("The user liked Angular before switching to React."),
  ]);

  assert.equal(result.preferences.length, 0);
});

test("consolidatePreferences preserves multiline use-for facts", () => {
  const result = consolidatePreferences([
    memory("The user uses React\nfor dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers to use React for dashboards",
  );
});

test("consolidatePreferences does not join separate use and movement sentences", () => {
  const result = consolidatePreferences([
    memory("The user uses React.\nThey moved to Svelte."),
  ]);

  assert.equal(result.preferences.length, 0);
});

test("consolidatePreferences preserves a first use clause before later sentences", () => {
  const result = consolidatePreferences([
    memory("The user uses React for dashboards.\nThey moved to Svelte."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user prefers to use React for dashboards",
  );
});

test("consolidatePreferences preserves does-not-use facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user does not use React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
  assert.equal(
    result.preferences[0]?.statement.includes("prefers to use"),
    false,
  );
});
