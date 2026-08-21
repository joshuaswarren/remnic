import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const INSTRUCTIONS_PATH = path.resolve(
  "packages/plugin-codex/memories_extensions/remnic/instructions.md",
);

const CHEATSHEET_PATH = path.resolve(
  "packages/plugin-codex/memories_extensions/remnic/resources/namespace-cheatsheet.md",
);

test("instructions.md exists and has non-trivial content", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.ok(content.length > 500, "instructions.md should be substantive");
});

test("instructions.md spells out the namespace resolution rule", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.match(content, /namespace/i);
  assert.match(content, /cwd[- ]derived/i);
  assert.match(content, /default/);
  assert.match(content, /shared/);
});

test("instructions.md describes the canonical Remnic file layout on disk", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.match(content, /MEMORY\.md/);
  assert.match(content, /memory_summary\.md/);
  assert.match(content, /skills\/.*SKILL\.md/s);
  assert.match(content, /rollout_summaries/);
  assert.match(content, /\.remnic\/memories/);
  assert.match(content, /REMNIC_HOME/);
});

test("instructions.md uses the oai-mem-citation block format", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.match(content, /<oai-mem-citation\s+path="[^"]+"\s*\/>/);
});

test("instructions.md states the no-network / filesystem-only constraint", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.match(content, /no network/i);
  assert.match(content, /filesystem/i);
  assert.match(content, /no mcp/i);
  assert.match(content, /no.*CLI|do not.*CLI|cli invocation/i);
});

test("instructions.md enumerates when NOT to consult Remnic", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  assert.match(content, /when NOT to consult|do not consult|skip/i);
  // Must include explicit skip guidance.
  assert.match(content, /transient|throwaway|one[- ]off/i);
});

test("instructions.md lists the authoritative categories Remnic owns", async () => {
  const content = await readFile(INSTRUCTIONS_PATH, "utf8");
  for (const term of [
    /preference/i,
    /convention/i,
    /workflow/i,
    /decision/i,
  ]) {
    assert.match(content, term);
  }
});

test("namespace-cheatsheet.md exists and documents anchor walk", async () => {
  const content = await readFile(CHEATSHEET_PATH, "utf8");
  assert.ok(content.length > 200);
  assert.match(content, /namespace/i);
  assert.match(content, /\.git/);
  assert.match(content, /package\.json|pyproject\.toml|Cargo\.toml|go\.mod/);
});
