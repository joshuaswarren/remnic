import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  collectModuleParserFiles,
  extractParsedKeyPaths,
} from "../scripts/config-contract/extract-parsed-keys.ts";

/**
 * check-config-contract v2 extractor (issue #1990 PR1).
 *
 * The committed snapshot (scripts/config-contract/parsed-keys.snapshot.json)
 * doubles as a config-surface change detector: a PR that adds/removes parsed
 * keys must regenerate it, making the config surface visible in review.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO_ROOT, "scripts", "config-contract", "fixtures");

function extractFixture() {
  return extractParsedKeyPaths({
    repoRoot: REPO_ROOT,
    entryFile: path.join(FIXTURES, "hand-rolled.ts"),
    entryFunction: "parseFixtureEntryConfig",
    includeFiles: [
      path.join(FIXTURES, "zod-based.ts"),
      path.join(FIXTURES, "mixed.ts"),
      path.join(FIXTURES, "unparseable.ts"),
    ],
  });
}

test("hand-rolled fixture: aliases, coercion helpers, nested blocks, and destructuring all resolve", () => {
  const { keys } = extractFixture();
  assert.ok(keys.includes("handRolled.enabled"), keys.join(","));
  assert.ok(keys.includes("handRolled.intervalMinutes"));
  assert.ok(keys.includes("handRolled.fusion.enabled"), "nested block via second alias");
  assert.ok(keys.includes("handRolled.fusion.gapMs"));
  assert.ok(keys.includes("handRolled.label"), "destructured key");
  assert.ok(keys.includes("topLevelFlag"), "entry parser direct read");
  // Method tails never leak as keys.
  assert.equal(keys.some((k) => k.endsWith(".trim")), false);
});

test("zod fixture: static z.object walk collects nested schema keys", () => {
  const { keys } = extractFixture();
  assert.ok(keys.includes("zodBlock.endpoint"), keys.filter((k) => k.startsWith("zodBlock")).join(","));
  assert.ok(keys.includes("zodBlock.retries"));
  assert.ok(keys.includes("zodBlock.nested.deadlineMs"), "nested z.object");
  assert.ok(keys.includes("zodBlock.nested.verbose"));
});

test("mixed fixture: zod half and hand-rolled half of the same parser both extract", () => {
  const { keys } = extractFixture();
  assert.ok(keys.includes("mixed.mode"), "zod half");
  assert.ok(keys.includes("mixed.extraKnob"), "hand-rolled half");
});

test("unparseable fixture: dynamic constructs are reported loudly, never silently skipped", () => {
  const { unparseable } = extractFixture();
  const fromFixture = unparseable.filter((u) => u.file.includes("fixtures/unparseable.ts"));
  assert.ok(fromFixture.length >= 2, JSON.stringify(unparseable));
  assert.ok(fromFixture.some((u) => u.reason.includes("Object.keys")));
  assert.ok(fromFixture.some((u) => u.reason.includes("computed element access")));
  for (const entry of fromFixture) {
    assert.ok(entry.line > 0, "every unparseable construct carries a line number");
  }
});

function extractReal() {
  return extractParsedKeyPaths({
    repoRoot: REPO_ROOT,
    entryFile: path.join(REPO_ROOT, "packages", "remnic-core", "src", "config.ts"),
    entryFunction: "parseConfig",
    includeFiles: collectModuleParserFiles(REPO_ROOT),
  });
}

test("real config.ts extraction matches the committed snapshot (config-surface change detector)", () => {
  const actual = extractReal();
  const snapshot = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "scripts", "config-contract", "parsed-keys.snapshot.json"), "utf8"),
  ) as { keys: string[]; unparseable: Array<{ file: string; line: number; reason: string }> };
  assert.deepEqual(
    actual.keys,
    snapshot.keys,
    "parsed config keys changed — regenerate scripts/config-contract/parsed-keys.snapshot.json " +
      "(npx tsx scripts/config-contract/extract-parsed-keys.ts > scripts/config-contract/parsed-keys.snapshot.json) " +
      "so the config-surface change is visible in review",
  );
  assert.deepEqual(actual.unparseable, snapshot.unparseable);
});

test("real extraction is deterministic across runs (§12: sorted output)", () => {
  const first = extractReal();
  const second = extractReal();
  assert.deepEqual(first, second);
  assert.deepEqual(first.keys, [...first.keys].sort(), "keys must be sorted");
});

test("real extraction covers the #1923 class: parser-only keys are visible", () => {
  const { keys } = extractReal();
  // codingKnowledge.lsp is the exact key reviewers caught missing on #1923 —
  // the extractor must see it in parser code.
  assert.ok(
    keys.some((k) => k.startsWith("codingKnowledge.")),
    "codingKnowledge block keys must extract",
  );
  assert.ok(keys.some((k) => k.startsWith("wearables.")), "delegated module parser keys must extract");
  assert.ok(keys.length > 500, `expected a substantial key surface, got ${keys.length}`);
});
