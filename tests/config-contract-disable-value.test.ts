import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertGrandfatherShrinkOnly,
  findDisableValueViolations,
  isZeroDisableDoc,
  runDisableValueCheck,
  type DisableValueGrandfatherEntry,
  type DisableValueManifest,
  type DisableValueSource,
} from "../scripts/config-contract/disable-value-check.js";

test("isZeroDisableDoc matches documented disable phrasings, not unrelated zeros", () => {
  for (const positive of [
    "Set to 0 to disable the gate.",
    "Default 5. Setting to 0 disables field injection.",
    "ttlMs <= 0 disables the check.",
    "Maximum follow-ups (0 disables that section).",
    "0 (disabled); otherwise must be >= days.",
  ]) {
    assert.equal(isZeroDisableDoc(positive), true, `should match: ${positive}`);
  }
  for (const negative of [
    "Default 0. A separate flag disables the feature entirely.",
    "Number of retries. Minimum 1.",
    "Disables the cache when the flag is false.",
  ]) {
    assert.equal(isZeroDisableDoc(negative), false, `should not match: ${negative}`);
  }
});

test("schema-min: documented '0 disables' property with schema minimum >= 1 is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: [
        "export interface Cfg {",
        "  /** Max candidates. Set to 0 to disable the dedup pass. */",
        "  semanticDedupCandidates: number;",
        "}",
      ].join("\n"),
    },
  ];
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: { semanticDedupCandidates: { type: "number", minimum: 1 } },
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-schema-min");
  assert.equal(violations[0].key, "semanticDedupCandidates@openclaw.plugin.json");
});

test("schema-min: minimum 0 honors the documented disable value (clean)", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  maxCandidates: number;\n}",
    },
  ];
  const manifests: DisableValueManifest[] = [
    { path: "openclaw.plugin.json", properties: { maxCandidates: { type: "number", minimum: 0 } } },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests }).violations, []);
});

test("schema description alone can mark a property zero-disable", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        maxFollowups: { type: "integer", minimum: 1, description: "Maximum LLM-suggested follow-ups (0 disables that section)." },
      },
    },
  ];
  const { violations, zeroDisableProperties } = findDisableValueViolations({ sources: [], manifests });
  assert.deepEqual(zeroDisableProperties, ["maxFollowups"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-schema-min");
});

test("guard: parser clamp Math.max(1, …) coerces 0 away and is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  return {",
        "    // 0 disables the cap.",
        "    maxItems: Math.max(1, coerceNumber(cfg.maxItems) ?? 0),",
        "  };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-guard");
  assert.equal(violations[0].key, "maxItems");
});

test("guard: parser clamp Math.max(0, …) preserves 0 (clean)", () => {
  const sources: DisableValueSource[] = [
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  return {",
        "    // 0 disables the cap.",
        "    maxItems: Math.max(0, coerceNumber(cfg.maxItems) ?? 0),",
        "  };",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: falsy-default (`… || 5`) coerces 0 away and is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  return {",
        "    // 0 disables the window.",
        "    windowDays: (coerceNumber(cfg.windowDays) || 5),",
        "  };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "windowDays");
});

test("guard: consumer `queued > threshold` with no zero short-circuit is flagged (the §33 known-bad)", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Flush when the queue exceeds this. Set to 0 to disable backpressure. */\n  backlogThreshold: number;\n}",
    },
    {
      path: "consumer.ts",
      text: "function tick(state: { queued: number }, config: { backlogThreshold: number }) {\n  if (state.queued > config.backlogThreshold) flush();\n}",
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-guard");
  assert.equal(violations[0].key, "backlogThreshold");
});

test("guard: consumer threshold WITH a `<= 0` short-circuit is clean", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable backpressure. */\n  backlogThreshold: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(state: { queued: number }, config: { backlogThreshold: number }) {",
        "  if (config.backlogThreshold <= 0) return;",
        "  if (state.queued > config.backlogThreshold) flush();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("runDisableValueCheck: grandfather suppresses a real violation and reports it active", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-disable-value-"));
  try {
    const typesPath = path.join(dir, "types.ts");
    const manifestPath = path.join(dir, "openclaw.plugin.json");
    const grandfatherPath = path.join(dir, "gf.json");
    await writeFile(
      typesPath,
      "export interface Cfg {\n  /** Set to 0 to disable. */\n  semanticDedupCandidates: number;\n}",
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ configSchema: { properties: { semanticDedupCandidates: { type: "number", minimum: 1 } } } }),
      "utf8",
    );

    const ungated = runDisableValueCheck({
      repoRoot: dir,
      sourceFiles: [typesPath],
      manifestPaths: [manifestPath],
      grandfatherPath,
      checkGrandfatherBaseline: false,
    });
    assert.equal(ungated.violations.length, 1, "ungated run flags the schema-min violation");

    await writeFile(
      grandfatherPath,
      JSON.stringify([
        { kind: "disable-value-schema-min", key: "semanticDedupCandidates@openclaw.plugin.json", issue: "#2070" },
      ]),
      "utf8",
    );
    const gated = runDisableValueCheck({
      repoRoot: dir,
      sourceFiles: [typesPath],
      manifestPaths: [manifestPath],
      grandfatherPath,
      checkGrandfatherBaseline: false,
    });
    assert.deepEqual(gated.violations, [], "grandfathered violation is suppressed");
    assert.equal(gated.grandfatheredActive, 1);
    assert.deepEqual(gated.staleGrandfatherEntries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDisableValueCheck: a grandfather entry that no longer violates is reported stale (shrink-only)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-disable-value-stale-"));
  try {
    const typesPath = path.join(dir, "types.ts");
    const grandfatherPath = path.join(dir, "gf.json");
    await writeFile(typesPath, "export interface Cfg {\n  enabled: boolean;\n}", "utf8");
    await writeFile(
      grandfatherPath,
      JSON.stringify([{ kind: "disable-value-guard", key: "somethingFixed", issue: "#2070" }]),
      "utf8",
    );
    const result = runDisableValueCheck({
      repoRoot: dir,
      sourceFiles: [typesPath],
      manifestPaths: [],
      grandfatherPath,
      checkGrandfatherBaseline: false,
    });
    assert.equal(result.staleGrandfatherEntries.length, 1);
    assert.equal(result.staleGrandfatherEntries[0].key, "somethingFixed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDisableValueCheck: a grandfather entry with an unknown kind is rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-disable-value-badkind-"));
  try {
    const grandfatherPath = path.join(dir, "gf.json");
    await writeFile(grandfatherPath, JSON.stringify([{ kind: "bogus", key: "x", issue: "#2070" }]), "utf8");
    assert.throws(
      () => runDisableValueCheck({ repoRoot: dir, sourceFiles: [], manifestPaths: [], grandfatherPath }),
      /entry must carry \{ kind, key, issue \}/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zero-disable phrasing wrapped across JSDoc lines is detected", () => {
  const wrapped = "/**\n * Retry budget before giving up. Setting to 0\n * disables the retry loop entirely.\n */";
  assert.equal(isZeroDisableDoc(wrapped), true);

  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: [
        "export interface Cfg {",
        "  /**",
        "   * Retry budget. Setting to 0",
        "   * disables retries.",
        "   */",
        "  retryBudget: number;",
        "}",
      ].join("\n"),
    },
  ];
  const manifests: DisableValueManifest[] = [
    { path: "openclaw.plugin.json", properties: { retryBudget: { type: "number", minimum: 1 } } },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests });
  assert.equal(violations.some((v) => v.kind === "disable-value-schema-min" && v.key.startsWith("retryBudget@")), true);
});

test("schema-min keys stay distinct across manifests that share a basename", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  maxCandidates: number;\n}",
    },
  ];
  const manifests: DisableValueManifest[] = [
    { path: "openclaw.plugin.json", properties: { maxCandidates: { type: "number", minimum: 1 } } },
    { path: "packages/plugin-openclaw/openclaw.plugin.json", properties: { maxCandidates: { type: "number", minimum: 1 } } },
  ];
  const keys = findDisableValueViolations({ sources, manifests })
    .violations.filter((v) => v.kind === "disable-value-schema-min")
    .map((v) => v.key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
});

test("nested schema property (procedural.*) with minimum >= 1 is flagged by dotted path", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        procedural: {
          type: "object",
          properties: {
            minOccurrences: { type: "integer", minimum: 1, description: "Minimum occurrences (0 disables mining)." },
          },
        },
      },
    },
  ];
  const { violations } = findDisableValueViolations({ sources: [], manifests });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-schema-min");
  assert.equal(violations[0].key, "procedural.minOccurrences@openclaw.plugin.json");
});

test("guard: a zero short-circuit in ONE consumer does not vouch for an unguarded use in another", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  backlogThreshold: number;\n}",
    },
    {
      path: "guarded.ts",
      text: [
        "function safe(state: { queued: number }, config: { backlogThreshold: number }) {",
        "  if (config.backlogThreshold <= 0) return;",
        "  if (state.queued > config.backlogThreshold) flush();",
        "}",
      ].join("\n"),
    },
    {
      path: "unguarded.ts",
      text: [
        "function risky(state: { queued: number }, config: { backlogThreshold: number }) {",
        "  if (state.queued > config.backlogThreshold) flush();",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "backlogThreshold");
});

test("guard: parser value in a same-named local returned via shorthand is scanned for coercion", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the cap. */\n  maxMemoriesPerDay: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const maxMemoriesPerDay = Math.max(1, coerceNumber(cfg.maxMemoriesPerDay) ?? 0);",
        "  return { maxMemoriesPerDay };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "maxMemoriesPerDay");
});

test("guard: a raw-local zero short-circuit before the clamp is NOT a false positive", () => {
  // Mirrors the real procedural.autoPromoteOccurrences parser: the disable value
  // is branched on the raw local, so Math.max(1, …) only runs for values > 0.
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable auto-promotion by count. */\n  autoPromote: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const raw = coerceNumber(cfg.autoPromote);",
        "  const autoPromote = raw !== undefined ? (raw <= 0 ? 0 : Math.max(1, Math.floor(raw))) : 8;",
        "  return { autoPromote };",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("assertGrandfatherShrinkOnly: a new exception absent from the baseline is rejected", () => {
  const baseline = new Set<string>(["disable-value-guard:existing"]);
  const current: DisableValueGrandfatherEntry[] = [
    { kind: "disable-value-guard", key: "existing", issue: "#2070" },
    { kind: "disable-value-schema-min", key: "brandNew@openclaw.plugin.json", issue: "#2070" },
  ];
  assert.throws(() => assertGrandfatherShrinkOnly(current, baseline), /new exception .* is not allowed/);
});

test("assertGrandfatherShrinkOnly: a subset of the baseline is allowed, and a null baseline is a no-op", () => {
  const baseline = new Set<string>(["disable-value-guard:a", "disable-value-guard:b"]);
  const shrunk: DisableValueGrandfatherEntry[] = [{ kind: "disable-value-guard", key: "a", issue: "#2070" }];
  assert.doesNotThrow(() => assertGrandfatherShrinkOnly(shrunk, baseline));
  assert.doesNotThrow(() =>
    assertGrandfatherShrinkOnly([{ kind: "disable-value-guard", key: "anything", issue: "#2070" }], null),
  );
});

test("runDisableValueCheck fails closed when the shrink-only baseline cannot be resolved", async () => {
  // Self-contained: build a throwaway Git work tree so the test does not depend
  // on the ambient cwd being a repo. An unresolvable base ref must refuse to run
  // open (never silently skip the ban), matching the v2 contract checker.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-disable-value-failclosed-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init");
    const grandfatherPath = path.join(dir, "gf.json");
    await writeFile(
      grandfatherPath,
      JSON.stringify([{ kind: "disable-value-guard", key: "x", issue: "#2070" }]),
      "utf8",
    );
    assert.throws(
      () =>
        runDisableValueCheck({
          repoRoot: dir,
          sourceFiles: [],
          manifestPaths: [],
          grandfatherPath,
          baselineRef: "refs/remnic-nonexistent-baseline-ref-2070",
        }),
      /refusing to run the §33 check open|cannot resolve the shrink-only baseline/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guard: a ternary whose zero branch does NOT return 0 still coerces (flagged)", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the cap. */\n  cap: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const raw = coerceNumber(cfg.cap) ?? 0;",
        "  const cap = raw <= 0 ? 5 : Math.max(1, raw);",
        "  return { cap };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("guard: threshold detection catches every inequality ordering", () => {
  for (const expr of [
    "config.cap > used",
    "used > config.cap",
    "config.cap < used",
    "used < config.cap",
  ]) {
    const sources: DisableValueSource[] = [
      {
        path: "types.ts",
        text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
      },
      {
        path: "consumer.ts",
        text: `function tick(used: number, config: { cap: number }) {\n  if (${expr}) act();\n}`,
      },
    ];
    const { violations } = findDisableValueViolations({ sources, manifests: [] });
    assert.equal(violations.length, 1, `ordering not detected: ${expr}`);
    assert.equal(violations[0].key, "cap");
  }
});

test("guard: a zero check on a DIFFERENT object with the same leaf does not vouch for the real threshold", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  backlogThreshold: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(state: { queued: number }, config: { backlogThreshold: number }, other: { backlogThreshold: number }) {",
        "  if (other.backlogThreshold <= 0) return;",
        "  if (state.queued > config.backlogThreshold) flush();",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "backlogThreshold");
});

test("guard: a same-named helper local NOT returned via shorthand is not a false coercion", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the section. */\n  maxFollowups: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const maxFollowups = coerceNumber(cfg.maxFollowups) ?? 0;",
        "  return { maxFollowups };",
        "}",
      ].join("\n"),
    },
    {
      path: "helper.ts",
      text: [
        "function renderFollowups(request: { maxFollowups: number }) {",
        "  const maxFollowups = Math.max(1, request.maxFollowups);",
        "  return maxFollowups * 2;",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a `>= 0` comparison is not a real disable guard (operator semantics)", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { cap: number }) {",
        "  if (config.cap >= 0) {",
        "    if (used > config.cap) act();",
        "  }",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1, "`>= 0` must not count as a disable guard");
  assert.equal(violations[0].key, "cap");
});

test("guard: valid disable guards short-circuit the use (guard clause, && conjunct, active if-block)", () => {
  const bodies = [
    // disabling guard clause with early return
    "  if (config.cap === 0) return;\n  if (used > config.cap) act();",
    "  if (config.cap <= 0) return;\n  if (used > config.cap) act();",
    // && short-circuit conjunct
    "  if (config.cap > 0 && used > config.cap) act();",
    // enclosing active if-block
    "  if (config.cap > 0) {\n    if (used > config.cap) act();\n  }",
  ];
  for (const body of bodies) {
    const sources: DisableValueSource[] = [
      {
        path: "types.ts",
        text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
      },
      {
        path: "consumer.ts",
        text: `function tick(used: number, config: { cap: number }) {\n${body}\n}`,
      },
    ];
    assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, [], `guard not honored: ${body}`);
  }
});

test("guard: an in-scope disable check that does NOT short-circuit the use is still flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { cap: number }) {",
        "  log(config.cap === 0);", // present in scope but does not gate the use
        "  if (used > config.cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("schema-min: a nested zero-disable doc does not falsely flag an undocumented top-level entry with the same leaf", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        // Nested, documented zero-disable, correctly minimum 0 — clean.
        block: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 0, description: "0 disables the block." } },
        },
        // Top-level, same leaf, minimum 1, but NOT documented zero-disable — must NOT be flagged.
        limit: { type: "integer", minimum: 1 },
      },
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources: [], manifests }).violations, []);
});

test("guard: a coerced local passed via shorthand to a call (not returned) is not a false coercion", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  maxItems: number;\n}",
    },
    {
      path: "helper.ts",
      text: [
        "function render(request: { maxItems: number }) {",
        "  const maxItems = Math.max(1, request.maxItems);",
        "  emit({ maxItems });",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a zero check gated behind another condition (`force && cap <= 0`) does not protect the threshold", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, force: boolean, config: { cap: number }) {",
        "  if (force && config.cap <= 0) return;",
        "  if (used > config.cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1, "a conditional zero check must not count as a disable guard");
  assert.equal(violations[0].key, "cap");
});

test("guard: a separate zero-preserving ternary does not mask a clamp that still coerces 0", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the cap. */\n  cap: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const raw = coerceNumber(cfg.cap) ?? 0;",
        "  const cap = (raw <= 0 ? 0 : raw) + Math.max(1, raw);",
        "  return { cap };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("guard: a destructured config threshold (`const { cap } = config`) with no zero short-circuit is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { cap: number }) {",
        "  const { cap } = config;",
        "  if (used > cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("guard: a destructured/aliased config threshold WITH a zero short-circuit is clean", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { cap: number }) {",
        "  const { cap: limit } = config;",
        "  if (limit <= 0) return;",
        "  if (used > limit) act();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a nested schema zero-disable doc does not flag an unrelated top-level field with the same leaf", () => {
  const sources: DisableValueSource[] = [
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { limit: number }) {",
        "  if (used > config.limit) act();",
        "}",
      ].join("\n"),
    },
  ];
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        block: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 0, description: "0 disables the block." } },
        },
        limit: { type: "integer", minimum: 0 },
      },
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests }).violations, []);
});

test("guard: a nested schema zero-disable doc with a UNIQUE leaf still scans its consumers", () => {
  const sources: DisableValueSource[] = [
    {
      path: "consumer.ts",
      text: [
        "function tick(count: number, config: { autoPromote: number }) {",
        "  if (count >= config.autoPromote) promote();",
        "}",
      ].join("\n"),
    },
  ];
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        procedural: {
          type: "object",
          properties: { autoPromote: { type: "integer", minimum: 0, description: "0 disables auto-promotion." } },
        },
      },
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-guard");
  assert.equal(violations[0].key, "autoPromote");
});

test("schema-min: a documented zero-disable field whose anyOf branches all reject 0 is flagged", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        cap: {
          description: "Set to 0 to disable.",
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
        },
      },
    },
  ];
  const { violations } = findDisableValueViolations({ sources: [], manifests });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-schema-min");
  assert.equal(violations[0].key, "cap@openclaw.plugin.json");
});

test("schema-min: a documented zero-disable field with an anyOf branch that admits 0 is clean", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        cap: {
          description: "Set to 0 to disable.",
          anyOf: [{ type: "integer", minimum: 1 }, { type: "integer", minimum: 0 }],
        },
      },
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources: [], manifests }).violations, []);
});

test("guard: a coercion on a local emitted through a nested returned object is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable auto-promotion. */\n  autoPromoteOccurrences: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const autoPromoteOccurrences = Math.max(1, coerceNumber(cfg.autoPromoteOccurrences) ?? 0);",
        "  const procedural = { autoPromoteOccurrences };",
        "  return { procedural };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-guard");
  assert.equal(violations[0].key, "autoPromoteOccurrences");
});

test("guard: a zero short-circuit combined with an independent feature gate (`!enabled || cap <= 0`) is honored", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, enabled: boolean, config: { cap: number }) {",
        "  if (!enabled || config.cap <= 0) return;",
        "  if (used > config.cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a feature-gated active guard (`enabled && cap > 0`) is honored", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, enabled: boolean, config: { cap: number }) {",
        "  if (enabled && config.cap > 0 && used > config.cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("schema-min: a parent `minimum: 1` with a `minimum: 0` anyOf branch still rejects 0 (flagged)", () => {
  const manifests: DisableValueManifest[] = [
    {
      path: "openclaw.plugin.json",
      properties: {
        cap: {
          type: "integer",
          minimum: 1,
          description: "Set to 0 to disable.",
          anyOf: [{ minimum: 0 }, { minimum: 5 }],
        },
      },
    },
  ];
  const { violations } = findDisableValueViolations({ sources: [], manifests });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "disable-value-schema-min");
  assert.equal(violations[0].key, "cap@openclaw.plugin.json");
});

test("guard: a destructured config alias does not leak into an unrelated sibling function", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function withConfig(config: { cap: number }) {",
        "  const { cap } = config;",
        "  if (cap <= 0) return;",
        "  emit(cap);",
        "}",
        "function unrelated(used: number, cap: number) {",
        "  if (used > cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a coercion routed through a differently named alias into a returned config field is flagged", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  maxItems: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const parsed = Math.max(1, coerceNumber(cfg.maxItems) ?? 0);",
        "  return { maxItems: parsed };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "maxItems");
});

test("guard: a ternary whose zero check tests an un-nameable value does not excuse the clamp", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the cap. */\n  cap: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const cap = coerceNumber(cfg.cap) <= 0 ? 0 : Math.max(1, coerceNumber(cfg.other));",
        "  return { cap };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("guard: a ternary whose zero check is gated by another condition (`flag && raw <= 0`) does not preserve zero", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the cap. */\n  cap: number;\n}",
    },
    {
      path: "config.ts",
      text: [
        "export function parseConfig(cfg: Record<string, unknown>) {",
        "  const raw = coerceNumber(cfg.cap) ?? 0;",
        "  const cap = flag && raw <= 0 ? 0 : Math.max(1, raw);",
        "  return { cap };",
        "}",
      ].join("\n"),
    },
  ];
  const { violations } = findDisableValueViolations({ sources, manifests: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "cap");
});

test("guard: a coerced local returned only from a nested inner function is not treated as outer parser output", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  maxItems: number;\n}",
    },
    {
      path: "helper.ts",
      text: [
        "function render(request: { maxItems: number }) {",
        "  const maxItems = Math.max(1, request.maxItems);",
        "  const build = () => {",
        "    return { maxItems };",
        "  };",
        "  return build();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a disabling `||` short-circuit (`cap <= 0 || used > cap`) is honored", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable. */\n  cap: number;\n}",
    },
    {
      path: "consumer.ts",
      text: [
        "function tick(used: number, config: { cap: number }) {",
        "  if (config.cap <= 0 || used > config.cap) act();",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});

test("guard: a coerced same-named local returned under a DIFFERENT key is not a false coercion", () => {
  const sources: DisableValueSource[] = [
    {
      path: "types.ts",
      text: "export interface Cfg {\n  /** Set to 0 to disable the section. */\n  maxFollowups: number;\n}",
    },
    {
      path: "helper.ts",
      text: [
        "function summarize(request: { maxFollowups: number }) {",
        "  const maxFollowups = Math.max(1, request.maxFollowups);",
        "  return { requested: maxFollowups };",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findDisableValueViolations({ sources, manifests: [] }).violations, []);
});
