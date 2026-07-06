/**
 * extraction-redaction-rules.test.ts — issue #1669 (#1580 follow-up).
 *
 * Proves the extraction-layer redaction-rule helper reads persisted
 * `redaction_rule` patterns and withholds matching content. The orchestrator
 * consults these rules before the storage write chokepoint so a never_store
 * correction actually blocks future extraction of matching content.
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  REDACTION_RULES_SUBDIR,
  compileRedactionPattern,
  contentMatchesRedactionRules,
  loadRedactionRules,
} from "./extraction-redaction-rules.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-redact-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRule(stateDir: string, pattern: string): Promise<void> {
  const dir = path.join(stateDir, REDACTION_RULES_SUBDIR);
  await mkdir(dir, { recursive: true });
  const slug = pattern.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 64) || "rule";
  await writeFile(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify({ pattern, namespace: "default", createdAt: "2026-07-06T00:00:00Z" })}\n`,
    "utf-8",
  );
}

test("compileRedactionPattern: literal pattern matches by substring", () => {
  const rule = compileRedactionPattern("secret-token-123");
  assert.ok(rule.matcher("the secret-token-123 leaked here"));
  assert.ok(!rule.matcher("nothing here"));
});

test("compileRedactionPattern: regex-like pattern compiles to a RegExp", () => {
  const rule = compileRedactionPattern("secret-token-\\d+");
  assert.ok(rule.matcher("found secret-token-999 in logs"));
  assert.ok(!rule.matcher("found secret-token-abc in logs"));
});

test("compileRedactionPattern: /wrapped/ regex strips delimiters", () => {
  const rule = compileRedactionPattern("/internal-only-[a-z]+/");
  assert.ok(rule.matcher("this is internal-only-foo data"));
  assert.ok(!rule.matcher("this is public data"));
});

test("compileRedactionPattern: malformed regex falls back to literal", () => {
  // Unbalanced bracket — would throw in `new RegExp`. Must not throw here.
  const rule = compileRedactionPattern("[unclosed");
  assert.ok(rule.matcher("contains [unclosed literally"));
  assert.ok(!rule.matcher("no match"));
});

test("loadRedactionRules: empty when the dir does not exist (cold install)", async () => {
  await withTempDir(async (dir) => {
    const rules = await loadRedactionRules(dir);
    assert.equal(rules.length, 0);
  });
});

test("loadRedactionRules: reads persisted literal + regex patterns", async () => {
  await withTempDir(async (dir) => {
    await writeRule(dir, "secret-token-123");
    await writeRule(dir, "api-key-[a-f0-9]{8}");
    const rules = await loadRedactionRules(dir);
    assert.equal(rules.length, 2);
    assert.ok(contentMatchesRedactionRules("leaked secret-token-123 here", rules));
    assert.ok(contentMatchesRedactionRules("api-key-deadbeef was used", rules));
    assert.ok(!contentMatchesRedactionRules("clean content", rules));
  });
});

test("loadRedactionRules: skips a corrupt rule file without failing the pass", async () => {
  await withTempDir(async (dir) => {
    await writeRule(dir, "good-pattern");
    const dir2 = path.join(dir, REDACTION_RULES_SUBDIR);
    // A non-JSON file masquerading as a rule.
    await writeFile(path.join(dir2, "broken.json"), "{not valid json", "utf-8");
    // A rule file missing the `pattern` field.
    await writeFile(path.join(dir2, "nopattern.json"), JSON.stringify({ foo: "bar" }), "utf-8");
    const rules = await loadRedactionRules(dir);
    assert.equal(rules.length, 1, "only the well-formed rule compiles");
    assert.ok(contentMatchesRedactionRules("good-pattern here", rules));
  });
});

test("contentMatchesRedactionRules: empty rule set never matches", () => {
  assert.equal(contentMatchesRedactionRules("anything", []), false);
});

test("regression (#1669): a persisted redaction rule blocks matching content", async () => {
  await withTempDir(async (dir) => {
    // Simulate a `redaction_rule` correction that persisted a never-store pattern.
    await writeRule(dir, "do-not-store-this-exact-phrase");
    const rules = await loadRedactionRules(dir);
    // Content matching the persisted pattern is withheld.
    assert.ok(
      contentMatchesRedactionRules("a fact containing do-not-store-this-exact-phrase inside", rules),
      "matching content must be withheld",
    );
    // Non-matching content passes through.
    assert.ok(
      !contentMatchesRedactionRules("a perfectly fine durable fact", rules),
      "non-matching content must pass",
    );
  });
});
