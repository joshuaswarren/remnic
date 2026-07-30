import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  extractParsedKeyPaths,
  extractRealConfigKeys,
} from "../scripts/config-contract/extract-parsed-keys.ts";
import { parseFixtureHandRolledConfig } from "../scripts/config-contract/fixtures/hand-rolled.ts";

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
  assert.equal(keys.includes("handRolled.unknown"), false, "rest binding is not a config key");
  assert.equal(
    extractFixture().unparseable.some((entry) => entry.file.endsWith("fixtures/hand-rolled.ts")),
    false,
    "iterating a rest binding is not dynamic parser-input iteration",
  );
  assert.ok(keys.includes("topLevelFlag"), "entry parser direct read");
  // Value properties never leak as config keys.
  assert.equal(keys.some((k) => k.endsWith(".trim") || k.endsWith(".length")), false);
});

test("hand-rolled fixture accepts every recognized runtime field", () => {
  assert.deepEqual(
    parseFixtureHandRolledConfig({
      enabled: true,
      intervalMinutes: 5,
      fusion: { enabled: true, gapMs: 250 },
      label: " fixture ",
    }),
    {
      enabled: true,
      intervalMinutes: 5,
      fusion: { enabled: true, gapMs: 250 },
      label: "fixture",
    },
  );
});

test("hand-rolled fixture rejects invalid recognized fields", () => {
  assert.throws(() => parseFixtureHandRolledConfig({ enabled: "true" }), /enabled/);
  assert.throws(() => parseFixtureHandRolledConfig({ intervalMinutes: 0 }), /intervalMinutes/);
  assert.throws(() => parseFixtureHandRolledConfig({ fusion: [] }), /fusion/);
  assert.throws(
    () => parseFixtureHandRolledConfig({ fusion: { enabled: "true" } }),
    /fusion.enabled/,
  );
  assert.throws(
    () => parseFixtureHandRolledConfig({ fusion: { gapMs: -1 } }),
    /fusion.gapMs/,
  );
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
    // Stable, line-independent construct id (issue #1990 review): keyed by
    // <file>#<hash>, never file:line, so unrelated edits don't restyle it.
    assert.match(entry.id, /^scripts\/config-contract\/fixtures\/unparseable\.ts#[0-9a-f]{12}$/);
    assert.equal(entry.id.includes(`:${entry.line}`), false, "id must not embed the line number");
  }
});

test("unparseable ids are scope-qualified: identical constructs in different functions do not collide (#1990)", () => {
  const { unparseable } = extractReal();
  // parseScopeProfiles and parseScopeTeams both run `Object.entries(value)` in
  // scope-profile-config.ts; scope-qualified ids must keep them distinct so
  // fixing or adding one dynamic loop is not silently hidden by the other.
  const scopeProfile = unparseable.filter((u) => u.file.endsWith("namespaces/scope-profile-config.ts"));
  assert.ok(scopeProfile.length >= 2, JSON.stringify(scopeProfile));
  const ids = scopeProfile.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, `scope-profile unparseable ids collide: ${ids.join(", ")}`);
});

function extractReal() {
  return extractRealConfigKeys(REPO_ROOT);
}

test("real config.ts extraction matches the committed snapshot (config-surface change detector)", () => {
  const actual = extractReal();
  const snapshot = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "scripts", "config-contract", "parsed-keys.snapshot.json"), "utf8"),
  ) as {
    keys: string[];
    unparseable: Array<{ file: string; reason: string; id: string }>;
    ambiguousValueMembers: string[];
  };
  assert.deepEqual(
    actual.keys,
    snapshot.keys,
    "parsed config keys changed — regenerate scripts/config-contract/parsed-keys.snapshot.json " +
      "(npx tsx scripts/config-contract/extract-parsed-keys.ts > scripts/config-contract/parsed-keys.snapshot.json) " +
      "so the config-surface change is visible in review",
  );
  // Compare stable fields only — the committed snapshot omits the volatile
  // `line`, so a construct that merely moves lines does not churn the snapshot
  // (issue #1990 review).
  assert.deepEqual(
    actual.unparseable.map(({ file, reason, id }) => ({ file, reason, id })),
    snapshot.unparseable,
  );
  // Round-3 review: the new ambiguousValueMembers surface must round-trip
  // too — dropped-but-reviewable value-member paths are part of the snapshot.
  assert.deepEqual(actual.ambiguousValueMembers, snapshot.ambiguousValueMembers);
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
  assert.ok(keys.includes("codingKnowledge.lsp"), "codingKnowledge.lsp - the exact #1923 key - must extract");
  assert.ok(keys.some((k) => k.startsWith("wearables.")), "delegated module parser keys must extract");
  assert.ok(keys.length > 500, `expected a substantial key surface, got ${keys.length}`);
});

test("array item-field traversal: named `.map(parseItemFn)` callbacks surface item keys", () => {
  const { keys } = extractReal();
  // recallPipeline items are parsed via rawPipeline.map(parseRecallSectionEntry);
  // the callback's per-item reads must surface as recallPipeline.<field> keys.
  for (const field of ["maxChars", "maxResults", "maxRubrics", "forceGeneric"]) {
    assert.ok(
      keys.includes(`recallPipeline.${field}`),
      `recallPipeline.${field} must extract from the .map callback`,
    );
  }
  // namespacePolicies is another config array parsed with a per-item callback.
  assert.ok(keys.includes("namespacePolicies.name"), "namespacePolicies.name must extract");
});

test("array item-field traversal: primitive-item arrays do not mint value-member keys", () => {
  const { keys } = extractReal();
  // taskModelChain.fallbacks is a string[]; its `.map((f) => f.trim())` callback
  // must NOT record a bogus taskModelChain.fallbacks.trim key.
  assert.ok(keys.includes("taskModelChain.fallbacks"), "the array key itself must extract");
  assert.equal(
    keys.includes("taskModelChain.fallbacks.trim"),
    false,
    "a primitive item's value-member call must not become a key",
  );
});

test("literal key-name binding: `readFlatOrNestedConfig(cfg, \"flatKey\", …)` surfaces the flat key", () => {
  const { keys } = extractReal();
  // The flat form is passed as a string literal into a reader helper that does
  // cfg[flatKey]; binding the literal makes it a real key instead of an
  // unparseable computed access (issue #1990 review).
  assert.ok(
    keys.includes("maintenanceNamespaceFanoutEnabled"),
    "the flat maintenanceNamespaceFanoutEnabled key must bind through the reader helper",
  );
});
