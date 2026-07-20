import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findDisableValueViolations,
  isZeroDisableDoc,
  runDisableValueCheck,
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
