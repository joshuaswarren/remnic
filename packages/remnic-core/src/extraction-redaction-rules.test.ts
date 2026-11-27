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
import { shouldPromoteGlobalFactToShared } from "./tool-scoped-memory.js";

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
  const rule = compileRedactionPattern("/secret-token-\\d+/");
  assert.ok(rule.matcher("found secret-token-999 in logs"));
  assert.ok(!rule.matcher("found secret-token-abc in logs"));
});

test("compileRedactionPattern (P1): unwrapped pattern with metacharacters is literal", () => {
  const rule = compileRedactionPattern("abc+def");
  assert.ok(rule.matcher("the value is abc+def here"),
    "unwrapped metachar pattern must match the literal substring");
  assert.ok(!rule.matcher("abccccdef"),
    "unwrapped metachar pattern must NOT be compiled as a regex");
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
    await writeFile(path.join(dir2, "broken.json"), "{not valid json", "utf-8");
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
    await writeRule(dir, "do-not-store-this-exact-phrase");
    const rules = await loadRedactionRules(dir);
    assert.ok(
      contentMatchesRedactionRules("a fact containing do-not-store-this-exact-phrase inside", rules),
      "matching content must be withheld",
    );
    assert.ok(
      !contentMatchesRedactionRules("a perfectly fine durable fact", rules),
      "non-matching content must pass",
    );
  });
});

test("#1669 thread #3: catastrophic-backtracking regex falls back to literal (ReDoS guard)", () => {
  const rule = compileRedactionPattern("(a+)+");
  assert.equal(rule.matcher("a fact with (a+)+ inside"), true,
    "literal fallback must still match the pattern as a substring");
  const nearMiss = "a".repeat(100) + "!";
  assert.equal(rule.matcher(nearMiss), false,
    "near-miss must not hang — literal fallback, not regex");
});

test("#1669 thread #3: safe regex pattern still compiles as RegExp", () => {
  const rule = compileRedactionPattern("/^secret-key-[a-f0-9]+$/");
  assert.equal(rule.matcher("secret-key-deadbeef"), true);
  assert.equal(rule.matcher("not-a-secret"), false);
});

test("#1669 cursor thread: overly broad /wrapped/ regex falls back to literal (not compiled)", () => {
  const rule = compileRedactionPattern("/.*/");
  assert.ok(!rule.matcher("any fact content"),
    "overly broad regex must not match arbitrary content");
  assert.ok(rule.matcher("contains .* literally"),
    "literal fallback on the body must still match the substring .*");
});

test("#1669 thread #3 (first-line guard): validateRedactionPattern rejects catastrophic-backtracking shapes", () => {
  const pathological = ["/(a+)+/", "/(a*)*/", "/(a?)+/", "/(a|a)+/"];
  for (const p of pathological) {
    assert.throws(
      () => validateRedactionPattern(p),
      { message: /unsafe/ },
      `validateRedactionPattern must reject catastrophic pattern: ${p}`,
    );
  }
  assert.throws(() => validateRedactionPattern("/.*/"));
  assert.throws(() => validateRedactionPattern("/.+/"));
  const nearMiss = "a".repeat(100) + "!";
  assert.ok(nearMiss.length === 101);
});

test("#1669 thread #3 (first-line guard): valid patterns still pass", () => {
  assert.equal(validateRedactionPattern("secret-token-\\d+"), "secret-token-\\d+");
  assert.equal(validateRedactionPattern("(a|b)+"), "(a|b)+");
  assert.equal(validateRedactionPattern("/^secret-key-[a-f0-9]+$/"), "/^secret-key-[a-f0-9]+$/");
});

test("#1669 P2: validateRedactionPattern rejects zero-width regex", () => {
  assert.throws(() => validateRedactionPattern("//"));
  assert.throws(() => validateRedactionPattern("/a?/"));
  assert.throws(() => validateRedactionPattern("/a*/"));
  assert.throws(() => validateRedactionPattern("/(a|)/"));
  assert.equal(validateRedactionPattern("/^secret-[a-f]+$/"), "/^secret-[a-f]+$/");
});

test("#1669 P2: compileRedactionPattern empty body never matches", () => {
  const rule = compileRedactionPattern("//");
  assert.equal(rule.matcher("anything"), false);
  assert.equal(rule.matcher(""), false);
});


test("#1713 Item 1: combined rules from source + target dirs catch cross-namespace patterns", async () => {
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (targetDir) => {
      await writeRule(sourceDir, "source-secret");
      await writeRule(targetDir, "target-confidential");

      const sourceRules = await loadRedactionRules(sourceDir);
      const targetRules = await loadRedactionRules(targetDir);
      const combined = [...sourceRules, ...targetRules];

      assert.equal(combined.length, 2);
      assert.ok(
        contentMatchesRedactionRules("leaked source-secret here", combined),
        "source-namespace rule must catch matching content",
      );
      assert.ok(
        contentMatchesRedactionRules("leaked target-confidential here", combined),
        "target-namespace rule must catch matching content when dirs are combined",
      );
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
      await writeRule(targetDir, "cross-ns-secret");

      const sourceOnlyRules = await loadRedactionRules(sourceDir);
      assert.equal(sourceOnlyRules.length, 0);
      assert.ok(
        !contentMatchesRedactionRules("cross-ns-secret in content", sourceOnlyRules),
        "source-only rules miss the target-namespace pattern (the pre-fix gap)",
      );

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
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (sharedDir) => {
      await writeRule(sharedDir, "shared-only-secret");

      const fact = { scope: "global" as string, content: "leaked shared-only-secret here" };
      const sharedNamespace: string = "shared";
      const sourceNamespace: string = "default"; // source !== shared

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

      const baseRules: CompiledRedactionRule[] = await loadRedactionRules(sourceDir);
      const targetRules: CompiledRedactionRule[] =
        factNs === sharedNamespace ? await loadRedactionRules(sharedDir) : [];
      const factRedactionRules: CompiledRedactionRule[] = [...baseRules, ...targetRules];

      assert.equal(baseRules.length, 0, "source namespace has no rules");
      assert.equal(targetRules.length, 1, "shared namespace carries the never-store rule");

      assert.ok(
        !contentMatchesRedactionRules(fact.content, baseRules),
        "source-only rules miss the shared-namespace never-store pattern (the gap)",
      );
      assert.ok(
        contentMatchesRedactionRules(fact.content, factRedactionRules),
        "combined source+shared rules catch the shared never-store at pre-judge (the fix)",
      );
    });
  });
});

test("#1713 (codex): non-global fact is NOT scope-routed to shared", async () => {
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
test("#2183: pre-judge consults the SESSION namespace rules for a tool-scoped global fact (not shared)", async () => {
  await withTempDir(async (sourceDir) => {
    await withTempDir(async (sharedDir) => {
      await writeRule(sourceDir, "session-only-secret");
      await writeRule(sharedDir, "shared-only-secret");

      const sourceNamespace: string = "default";
      const sharedNamespace: string = "shared";
      const sourceConnector = "pi";

      async function consultedRulesFor(fact: { scope: string; content: string }): Promise<CompiledRedactionRule[]> {
        const baseRules = await loadRedactionRules(sourceDir);
        const promote = shouldPromoteGlobalFactToShared({
          scope: fact.scope,
          content: fact.content,
          sourceConnector,
        });
        const factNs = promote ? sharedNamespace : undefined;
        const targetRules =
          factNs && factNs !== sourceNamespace ? await loadRedactionRules(sharedDir) : [];
        return [...baseRules, ...targetRules];
      }

      const toolRules = await consultedRulesFor({ scope: "global", content: "Prefer the search tool when locating code." });
      assert.ok(
        contentMatchesRedactionRules("session-only-secret here", toolRules),
        "session rules are consulted for a tool-scoped global fact",
      );
      assert.ok(
        !contentMatchesRedactionRules("shared-only-secret here", toolRules),
        "shared rules are NOT consulted for a tool-scoped global fact (the #2183 fix)",
      );

      const portableRules = await consultedRulesFor({ scope: "global", content: "User prefers dark mode in all editors" });
      assert.ok(
        contentMatchesRedactionRules("shared-only-secret here", portableRules),
        "shared rules ARE consulted for a portable global fact (no regression)",
      );
    });
  });
});
