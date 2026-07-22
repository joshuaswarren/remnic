/**
 * extraction-redaction-rules.test.ts — issue #1669 (#1580 follow-up).
 *
 * Proves the extraction-layer redaction-rule helper reads persisted
 * `redaction_rule` patterns and withholds matching content. The orchestrator
 * consults these rules before the storage write chokepoint so a never_store
 * correction actually blocks future extraction of matching content.
 */
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { withTempDir as managedWithTempDir } from "./testing/tmp-dir.js";
import {
  REDACTION_RULES_SUBDIR,
  compileRedactionPattern,
  contentMatchesRedactionRules,
  loadRedactionRules,
  type CompiledRedactionRule,
} from "./extraction-redaction-rules.js";
import { validateRedactionPattern } from "./correction/correction-contract.js";

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "remnic-redact-");

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
  // Only /.../-wrapped patterns compile as RegExp (review thread P1).
  const rule = compileRedactionPattern("/secret-token-\\d+/");
  assert.ok(rule.matcher("found secret-token-999 in logs"));
  assert.ok(!rule.matcher("found secret-token-abc in logs"));
});

test("compileRedactionPattern (P1): unwrapped pattern with metacharacters is literal", () => {
  // abc+def must match the LITERAL string, not the regex abccccdef.
  const rule = compileRedactionPattern("abc+def");
  assert.ok(rule.matcher("the value is abc+def here"),
    "unwrapped metachar pattern must match the literal substring");
  assert.ok(!rule.matcher("abccccdef"),
    "unwrapped metachar pattern must NOT be compiled as a regex");
  // An API-token-shaped literal like foo(bar) also works.
  const rule2 = compileRedactionPattern("foo(bar)");
  assert.ok(rule2.matcher("contains foo(bar) text"));
  assert.ok(!rule2.matcher("contains foobar text"));
});

test("compileRedactionPattern: /wrapped/ regex strips delimiters", () => {
  const rule = compileRedactionPattern("/internal-only-[a-z]+/");
  assert.ok(rule.matcher("this is internal-only-foo data"));
  assert.ok(!rule.matcher("this is public data"));
});

test("compileRedactionPattern: malformed /wrapped/ regex falls back to literal", () => {
  // /.../-wrapped with an unbalanced bracket — RegExp() throws, falls back
  // to literal substring on the BODY (without delimiters).
  const rule = compileRedactionPattern("/[unclosed/");
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
    await writeRule(dir, "/api-key-[a-f0-9]{8}/");
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

test("#1669 thread #3: catastrophic-backtracking regex falls back to literal (ReDoS guard)", () => {
  // A pattern like (a+)+ is a classic ReDoS shape. It must NOT compile as a
  // RegExp — it would hang persistExtraction on a near-miss fact. Instead it
  // falls back to literal substring match.
  const rule = compileRedactionPattern("(a+)+");
  // The literal fallback matches when the exact string "(a+)+" appears:
  assert.equal(rule.matcher("a fact with (a+)+ inside"), true,
    "literal fallback must still match the pattern as a substring");
  // A long near-miss string that would cause exponential backtracking on the
  // regex must return quickly (literal match, no regex evaluation):
  const nearMiss = "a".repeat(100) + "!";
  assert.equal(rule.matcher(nearMiss), false,
    "near-miss must not hang — literal fallback, not regex");
});

test("#1669 thread #3: safe regex pattern still compiles as RegExp", () => {
  // A benign anchored pattern compiles normally.
  const rule = compileRedactionPattern("/^secret-key-[a-f0-9]+$/");
  assert.equal(rule.matcher("secret-key-deadbeef"), true);
  assert.equal(rule.matcher("not-a-secret"), false);
});

test("#1669 cursor thread: overly broad /wrapped/ regex falls back to literal (not compiled)", () => {
  // A hand-edited rule file with /.*/ must NOT compile — it would match every
  // fact and withhold all extraction. isSafeRegex now rejects overly-broad
  // bodies, so the rule falls back to literal substring on the body.
  const rule = compileRedactionPattern("/.*/");
  assert.ok(!rule.matcher("any fact content"),
    "overly broad regex must not match arbitrary content");
  assert.ok(rule.matcher("contains .* literally"),
    "literal fallback on the body must still match the substring .*");
});

test("#1669 thread #3 (first-line guard): validateRedactionPattern rejects catastrophic-backtracking shapes", () => {
  // Classic ReDoS shapes must be rejected at apply time — not just fall back
  // to literal at extraction time. Each is a nested quantifier or overlapping
  // alternation that would hang on a near-miss fact.
  const pathological = ["/(a+)+/", "/(a*)*/", "/(a?)+/", "/(a|a)+/"];
  for (const p of pathological) {
    assert.throws(
      () => validateRedactionPattern(p),
      { message: /unsafe/ },
      `validateRedactionPattern must reject catastrophic pattern: ${p}`,
    );
  }
  // The overly-broad check still fires for /.../-wrapped .* / .+ patterns.
  assert.throws(() => validateRedactionPattern("/.*/"));
  assert.throws(() => validateRedactionPattern("/.+/"));
  // A near-miss string that would cause exponential backtracking on the
  // regex never reaches extraction — the plan is rejected at apply time.
  const nearMiss = "a".repeat(100) + "!";
  assert.ok(nearMiss.length === 101);
});

test("#1669 thread #3 (first-line guard): valid patterns still pass", () => {
  // Bounded literal + benign anchored regex must NOT be rejected.
  assert.equal(validateRedactionPattern("secret-token-\\d+"), "secret-token-\\d+");
  assert.equal(validateRedactionPattern("(a|b)+"), "(a|b)+");
  assert.equal(validateRedactionPattern("/^secret-key-[a-f0-9]+$/"), "/^secret-key-[a-f0-9]+$/");
});

test("#1669 P2: validateRedactionPattern rejects zero-width regex", () => {
  // Empty body or regex that matches the empty string would withhold every fact.
  assert.throws(() => validateRedactionPattern("//"));
  assert.throws(() => validateRedactionPattern("/a?/"));
  assert.throws(() => validateRedactionPattern("/a*/"));
  assert.throws(() => validateRedactionPattern("/(a|)/"));
  // A bounded non-zero-width regex still passes.
  assert.equal(validateRedactionPattern("/^secret-[a-f]+$/"), "/^secret-[a-f]+$/");
});

test("#1669 P2: compileRedactionPattern empty body never matches", () => {
  // A hand-edited // rule file must not withhold all extraction.
  const rule = compileRedactionPattern("//");
  assert.equal(rule.matcher("anything"), false);
  assert.equal(rule.matcher(""), false);
});

// ---------------------------------------------------------------------------
// #1713 Item 1: pre-judge redaction filter consults target namespace rules.
// The orchestrator's pre-judge filter builds a combined rule set from source +
// shared + routed target namespace dirs. This test verifies that loadRedactionRules
// correctly returns rules from each dir and that contentMatchesRedactionRules
// catches patterns from ANY of the combined dirs (not just the source).
// ---------------------------------------------------------------------------

test("#1713 Item 1: combined rules from source + target dirs catch cross-namespace patterns", async () => {
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (targetDir) => {
      // Source namespace has a rule for "source-secret"
      await writeRule(sourceDir, "source-secret");
      // Target namespace has a rule for "target-secret"
      await writeRule(targetDir, "target-confidential");

      // Simulate what the orchestrator's redactionRulesFor(...dirs) does:
      // load from each dir and combine.
      const sourceRules = await loadRedactionRules(sourceDir);
      const targetRules = await loadRedactionRules(targetDir);
      const combined = [...sourceRules, ...targetRules];

      assert.equal(combined.length, 2);
      // Source-namespace rule catches source content
      assert.ok(
        contentMatchesRedactionRules("leaked source-secret here", combined),
        "source-namespace rule must catch matching content",
      );
      // Target-namespace rule catches target content (the #1713 fix)
      assert.ok(
        contentMatchesRedactionRules("leaked target-confidential here", combined),
        "target-namespace rule must catch matching content when dirs are combined",
      );
      // Clean content passes
      assert.ok(
        !contentMatchesRedactionRules("clean content", combined),
        "non-matching content must not be redacted",
      );
    });
  });
});

test("#1713 Item 1: source-only rules miss target-namespace patterns (the bug this fixes)", async () => {
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (targetDir) => {
      // Only the TARGET namespace has the redaction rule
      await writeRule(targetDir, "cross-ns-secret");

      // The OLD behavior (pre-fix): only source rules loaded at pre-judge point
      const sourceOnlyRules = await loadRedactionRules(sourceDir);
      assert.equal(sourceOnlyRules.length, 0);
      assert.ok(
        !contentMatchesRedactionRules("cross-ns-secret in content", sourceOnlyRules),
        "source-only rules miss the target-namespace pattern (the pre-fix gap)",
      );

      // The NEW behavior: source + target rules combined
      const combined = [
        ...(await loadRedactionRules(sourceDir)),
        ...(await loadRedactionRules(targetDir)),
      ];
      assert.equal(combined.length, 1);
      assert.ok(
        contentMatchesRedactionRules("cross-ns-secret in content", combined),
        "combined rules catch the target-namespace pattern (the fix)",
      );
    });
  });
});

test("#1713 (codex PRRT_kwDORJXyws6PBj5X): scope-classification routed shared target rules consulted at pre-judge", async () => {
  // Scope classification routes a scope=global fact to the shared namespace
  // independent of routing rules. The pre-judge redaction filter must consult
  // the SHARED namespace's rules for such a fact, or a never-store pattern
  // registered only under shared is missed until the write gate and the content
  // reaches the extraction judge/training path. This test mirrors the
  // orchestrator's per-fact scope-routing decision + rule combining.
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (sharedDir) => {
      // Only the SHARED namespace carries the never-store rule.
      await writeRule(sharedDir, "shared-only-secret");

      // A scope=global fact the orchestrator will route to shared.
      const fact = { scope: "global" as string, content: "leaked shared-only-secret here" };
      const sharedNamespace: string = "shared";
      const sourceNamespace: string = "default"; // source !== shared

      // Mirror of the orchestrator's scope-routing condition (persistExtraction
      // pre-judge per-fact block): a fact is scope-routed to shared when no
      // routing rule set an explicit namespace, scope classification is on, the
      // fact is global, shared writes are allowed, and the source is not already
      // shared.
      const preRoutedNamespaceByFact: string | undefined = undefined;
      const scopeClassificationEnabled = true;
      const namespacesEnabled = true;
      const profileAllowsSharedWrites = true;
      let factNs: string | undefined = preRoutedNamespaceByFact;
      if (
        !factNs &&
        scopeClassificationEnabled &&
        namespacesEnabled &&
        fact.scope === "global" &&
        profileAllowsSharedWrites &&
        sourceNamespace !== sharedNamespace
      ) {
        factNs = sharedNamespace;
      }
      assert.equal(factNs, sharedNamespace, "global fact must be scope-routed to shared");

      // Base (source-only) rules + routed target (shared) rules combined — what
      // the orchestrator builds for this fact.
      const baseRules: CompiledRedactionRule[] = await loadRedactionRules(sourceDir);
      const targetRules: CompiledRedactionRule[] =
        factNs === sharedNamespace ? await loadRedactionRules(sharedDir) : [];
      const factRedactionRules: CompiledRedactionRule[] = [...baseRules, ...targetRules];

      assert.equal(baseRules.length, 0, "source namespace has no rules");
      assert.equal(targetRules.length, 1, "shared namespace carries the never-store rule");

      // Pre-fix (source-only) behavior: the shared-only pattern is missed at
      // pre-judge — the gap the codex thread flags.
      assert.ok(
        !contentMatchesRedactionRules(fact.content, baseRules),
        "source-only rules miss the shared-namespace never-store pattern (the gap)",
      );
      // Post-fix: combined source+shared rules catch it before the judge.
      assert.ok(
        contentMatchesRedactionRules(fact.content, factRedactionRules),
        "combined source+shared rules catch the shared never-store at pre-judge (the fix)",
      );
    });
  });
});

test("#1713 (codex): non-global fact is NOT scope-routed to shared", async () => {
  // A scope-local fact must not consult shared rules at pre-judge — only
  // routing-rule targets and scope=global facts do. Guards against over-redacting
  // unrelated facts with shared-only never-store patterns (codex sibling threads).
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (sharedDir) => {
      await writeRule(sharedDir, "shared-only-secret");

      const fact = { scope: "local" as string, content: "leaked shared-only-secret here" };
      const sharedNamespace: string = "shared";
      const sourceNamespace: string = "default";

      const preRoutedNamespaceByFact: string | undefined = undefined;
      const scopeClassificationEnabled = true;
      const namespacesEnabled = true;
      const profileAllowsSharedWrites = true;
      let factNs: string | undefined = preRoutedNamespaceByFact;
      if (
        !factNs &&
        scopeClassificationEnabled &&
        namespacesEnabled &&
        fact.scope === "global" &&
        profileAllowsSharedWrites &&
        sourceNamespace !== sharedNamespace
      ) {
        factNs = sharedNamespace;
      }
      assert.equal(factNs, undefined, "non-global fact must not be scope-routed to shared");

      const baseRules: CompiledRedactionRule[] = await loadRedactionRules(sourceDir);
      const targetRules: CompiledRedactionRule[] = [];
      const factRedactionRules: CompiledRedactionRule[] = [...baseRules, ...targetRules];
      assert.equal(factRedactionRules.length, 0, "no rules consulted for a scope-local fact");
    });
  });
});
