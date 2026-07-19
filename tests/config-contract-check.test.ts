import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runContractCheck } from "../scripts/config-contract/contract-check.ts";
import type { ContractCheckResult } from "../scripts/config-contract/contract-check.ts";

/**
 * check-config-contract v2 comparisons (issue #1990 PR2) — the falsifiable
 * acceptance criteria, exercised on synthetic fixtures:
 *   1. reproduce #1923's exact miss (parsed key, no manifests) → fails
 *      naming the key and both missing manifests;
 *   2. delete a parsed key while leaving its schema entry → dead schema;
 *   3. grandfather semantics: entry passes; a stale entry (violation fixed,
 *      manifest not pruned) FAILS.
 */

function makeFixtureRepo(options: {
  parserExtraKey?: boolean;
  schemaExtraTopKey?: boolean;
  schemaExtraNestedKey?: boolean;
  docsBogus?: string;
  unparseableBody?: boolean;
  grandfather?: Array<{ kind: string; key: string; issue: string }>;
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "config-contract-"));
  const parserPath = path.join(root, "parser.ts");
  const parserTemplate = options.unparseableBody
    ? `
type Rec = Record<string, unknown>;
export function parseFixtureBlockConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" ? (value as Rec) : {};
  const out: Rec = {};
  for (const key of Object.keys(raw)) { out[key] = raw[key]; }
  out.enabled = raw.enabled;
  return out;
}
export function parseRootConfig(raw: unknown): Rec {
  const cfg = raw && typeof raw === "object" ? (raw as Rec) : {};
  return { topFlag: cfg.topFlag === true, codingKnowledge: parseFixtureBlockConfig(cfg.codingKnowledge) };
}
`
    : `
type Rec = Record<string, unknown>;
export function parseFixtureBlockConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" ? (value as Rec) : {};
  return {
    enabled: raw.enabled === true,
    ${options.parserExtraKey ? "fixture: raw.fixture," : ""}
  };
}
export function parseRootConfig(raw: unknown): Rec {
  const cfg = raw && typeof raw === "object" ? (raw as Rec) : {};
  return {
    topFlag: cfg.topFlag === true,
    codingKnowledge: parseFixtureBlockConfig(cfg.codingKnowledge),
  };
}
`;
  writeFileSync(parserPath, parserTemplate);
  const schema = {
    configSchema: {
      properties: {
        topFlag: { type: "boolean" },
        codingKnowledge: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            ...(options.schemaExtraNestedKey ? { typo: { type: "string" } } : {}),
          },
        },
        ...(options.schemaExtraTopKey ? { deadTopKey: { type: "string" } } : {}),
      },
    },
  };
  const manifestA = path.join(root, "manifest-a.json");
  const manifestB = path.join(root, "manifest-b.json");
  writeFileSync(manifestA, JSON.stringify(schema, null, 2));
  writeFileSync(manifestB, JSON.stringify(schema, null, 2));
  const docsPath = path.join(root, "docs.md");
  writeFileSync(
    docsPath,
    // Docs mention exactly the keys the fixture variant declares — the
    // documented-nonexistent check correctly flags anything beyond them.
    `Config keys: \`topFlag\`, \`codingKnowledge.enabled\`${options.parserExtraKey ? ", \`codingKnowledge.fixture\`" : ""}${options.schemaExtraTopKey ? ", \`deadTopKey\`" : ""}${options.docsBogus ? `, \`${options.docsBogus}\`` : ""}.\n`,
  );
  const grandfatherPath = path.join(root, "grandfathered.json");
  if (options.grandfather) {
    writeFileSync(grandfatherPath, JSON.stringify(options.grandfather, null, 2));
  }
  return {
    root,
    run: () =>
      runContractCheck({
        repoRoot: root,
        entryFile: parserPath,
        entryFunction: "parseRootConfig",
        includeFiles: [],
        manifestPaths: [manifestA, manifestB],
        docsPath,
        grandfatherPath,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("documented-nonexistent: a docs path under a known top-level key that matches nothing fails", () => {
  const fixture = makeFixtureRepo({ docsBogus: "codingKnowledge.nope" });
  try {
    const result = fixture.run();
    assert.ok(
      result.violations.some((v) => v.kind === "documented-nonexistent" && v.key === "codingKnowledge.nope"),
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("unparseable construct: a dynamic Object.keys loop over the parser input surfaces loudly", () => {
  const fixture = makeFixtureRepo({ unparseableBody: true });
  try {
    const result = fixture.run();
    assert.ok(
      result.violations.some(
        (v) =>
          v.kind === "unparseable-construct" &&
          // Stable construct-id key; the human-readable file:line rides in detail.
          /^parser\.ts#[0-9a-f]+$/.test(v.key) &&
          /parser\.ts:\d+/.test(v.detail),
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("#1923 reproduction: a parsed key missing from the manifests fails naming the key and BOTH manifests", () => {
  const fixture = makeFixtureRepo({ parserExtraKey: true });
  try {
    const result = fixture.run();
    const miss = result.violations.find(
      (violation) => violation.kind === "missing-schema" && violation.key === "codingKnowledge.fixture",
    );
    assert.ok(miss, JSON.stringify(result.violations));
    assert.match(miss.detail, /manifest-a\.json/);
    assert.match(miss.detail, /manifest-b\.json/);
  } finally {
    fixture.cleanup();
  }
});

test("dead schema: a schema key with no parsed counterpart fails as dead-schema", () => {
  const fixture = makeFixtureRepo({ schemaExtraTopKey: true });
  try {
    const result = fixture.run();
    assert.ok(
      result.violations.some(
        (violation) => violation.kind === "dead-schema" && violation.key === "deadTopKey",
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("dead schema: a nested sibling is not covered by a parsed ancestor", () => {
  const fixture = makeFixtureRepo({ schemaExtraNestedKey: true });
  try {
    const result = fixture.run();
    assert.ok(
      result.violations.some(
        (violation) => violation.kind === "dead-schema" && violation.key === "codingKnowledge.typo",
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("grandfather manifest rejects unsupported kinds and empty keys", () => {
  const fixture = makeFixtureRepo({
    grandfather: [{ kind: "not-a-violation", key: "", issue: "#1990" }],
  });
  try {
    assert.throws(() => fixture.run(), /grandfather entry must carry/);
  } finally {
    fixture.cleanup();
  }
});

test("grandfather manifest: an entry suppresses its violation; a stale entry FAILS", () => {
  // Entry matches the live violation -> suppressed.
  const active = makeFixtureRepo({
    parserExtraKey: true,
    grandfather: [{ kind: "missing-schema", key: "codingKnowledge.fixture", issue: "#1990" }],
  });
  try {
    const result = active.run();
    assert.equal(
      result.violations.some((violation) => violation.key === "codingKnowledge.fixture"),
      false,
      "grandfathered violation must be suppressed",
    );
    assert.equal(result.staleGrandfatherEntries.length, 0);
    assert.equal(result.grandfatheredActive, 1);
  } finally {
    active.cleanup();
  }

  // Violation fixed but manifest NOT pruned -> stale entry reported.
  const stale = makeFixtureRepo({
    grandfather: [{ kind: "missing-schema", key: "codingKnowledge.fixture", issue: "#1990" }],
  });
  try {
    const result = stale.run();
    assert.equal(result.staleGrandfatherEntries.length, 1, "staleness is a failure, not a comfort");
    assert.equal(result.staleGrandfatherEntries[0].key, "codingKnowledge.fixture");
  } finally {
    stale.cleanup();
  }
});

test("clean fixture: no violations, no stale entries", () => {
  const fixture = makeFixtureRepo({});
  try {
    const result = fixture.run();
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.staleGrandfatherEntries, []);
  } finally {
    fixture.cleanup();
  }
});

function initGitRepo(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=fixture", ...args],
      { stdio: "ignore" },
    );
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture baseline");
}

test("grandfather ban fails closed when a real checkout cannot resolve the base (#1990)", () => {
  const fixture = makeFixtureRepo({
    parserExtraKey: true,
    grandfather: [{ kind: "missing-schema", key: "codingKnowledge.fixture", issue: "#1990" }],
  });
  try {
    initGitRepo(fixture.root);
    // A Git work tree with no resolvable origin/main must refuse to run open,
    // otherwise a checkout without the base could add a fresh exception silently.
    assert.throws(
      () => fixture.run(),
      /cannot resolve the shrink-only grandfather baseline/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("grandfather ban: a prior entry passes; a newly added entry is rejected (#1990)", () => {
  const fixture = makeFixtureRepo({
    parserExtraKey: true,
    grandfather: [{ kind: "missing-schema", key: "codingKnowledge.fixture", issue: "#1990" }],
  });
  try {
    initGitRepo(fixture.root);
    // Pin the base at the committed manifest (holds only the prior entry).
    execFileSync("git", ["-C", fixture.root, "update-ref", "refs/remotes/origin/main", "HEAD"], {
      stdio: "ignore",
    });
    // The prior entry exists at the base → accepted, its violation suppressed.
    const accepted = fixture.run();
    assert.equal(
      accepted.violations.some((violation) => violation.key === "codingKnowledge.fixture"),
      false,
    );
    // Add a NEW exception absent from the base → the shrink-only ban rejects it.
    writeFileSync(
      path.join(fixture.root, "grandfathered.json"),
      JSON.stringify(
        [
          { kind: "missing-schema", key: "codingKnowledge.fixture", issue: "#1990" },
          { kind: "missing-schema", key: "codingKnowledge.sneaky", issue: "#1990" },
        ],
        null,
        2,
      ),
    );
    assert.throws(
      () => fixture.run(),
      /new grandfather entry missing-schema:codingKnowledge\.sneaky is not allowed/,
    );
  } finally {
    fixture.cleanup();
  }
});

function makeArrayFixtureRepo(schema: unknown): { run: () => ContractCheckResult; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "config-contract-array-"));
  const parserPath = path.join(root, "parser.ts");
  writeFileSync(
    parserPath,
    `
type Rec = Record<string, unknown>;
export function parseItem(raw: unknown): Rec {
  const e = raw && typeof raw === "object" ? (raw as Rec) : {};
  return { id: e.id, weight: e.weight };
}
export function parseRootConfig(raw: unknown): Rec {
  const cfg = raw && typeof raw === "object" ? (raw as Rec) : {};
  return {
    parsedList: Array.isArray(cfg.parsedList) ? cfg.parsedList.map(parseItem) : [],
    passThroughList: Array.isArray(cfg.passThroughList) ? (cfg.passThroughList as unknown[]) : [],
    combo: cfg.combo && typeof cfg.combo === "object" ? { keep: (cfg.combo as Rec).keep } : {},
    altBlock: cfg.altBlock,
    mapBlock: cfg.mapBlock && typeof cfg.mapBlock === "object" ? (cfg.mapBlock as Rec) : {},
  };
}
`,
  );
  const manifest = path.join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify(schema, null, 2));
  const docsPath = path.join(root, "docs.md");
  writeFileSync(
    docsPath,
    "Config: `parsedList[].id`, `parsedList[].weight`, `passThroughList`, `combo`, `combo.keep`, `altBlock`, `mapBlock`.\n",
  );
  return {
    run: () =>
      runContractCheck({
        repoRoot: root,
        entryFile: parserPath,
        entryFunction: "parseRootConfig",
        includeFiles: [],
        manifestPaths: [manifest],
        docsPath,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("array item flattening: parsed-array item drift surfaces dead + missing schema (#1990)", () => {
  const fixture = makeArrayFixtureRepo({
    configSchema: {
      properties: {
        // parser reads item.id + item.weight; schema omits weight (missing) and
        // declares a bogus deadItem (dead) — both must surface for a parsed array.
        parsedList: { type: "array", items: { type: "object", properties: { id: { type: "string" }, deadItem: { type: "string" } } } },
        passThroughList: { type: "array", items: { type: "object", properties: {} } },
        combo: { type: "object", properties: { keep: { type: "string" } } },
      },
    },
  });
  try {
    const result = fixture.run();
    const kinds = result.violations.map((v) => `${v.kind}:${v.key}`);
    assert.ok(kinds.includes("dead-schema:parsedList.deadItem"), JSON.stringify(kinds));
    assert.ok(kinds.includes("missing-schema:parsedList.weight"), JSON.stringify(kinds));
  } finally {
    fixture.cleanup();
  }
});

test("array item flattening: pass-through arrays are not dead-schema-flagged (#1990)", () => {
  const fixture = makeArrayFixtureRepo({
    configSchema: {
      properties: {
        parsedList: { type: "array", items: { type: "object", properties: { id: { type: "string" }, weight: { type: "number" } } } },
        // passThroughList items are never parsed (raw hand-off) — declared item
        // fields must NOT surface as dead-schema.
        passThroughList: { type: "array", items: { type: "object", properties: { rootDir: { type: "string" } } } },
        combo: { type: "object", properties: { keep: { type: "string" } } },
      },
    },
  });
  try {
    const result = fixture.run();
    assert.equal(
      result.violations.some((v) => v.key.startsWith("passThroughList.")),
      false,
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("composition: allOf props are enforced, anyOf/oneOf alternatives are absorbed (#1990)", () => {
  const fixture = makeArrayFixtureRepo({
    configSchema: {
      properties: {
        parsedList: { type: "array", items: { type: "object", properties: { id: { type: "string" }, weight: { type: "number" } } } },
        passThroughList: { type: "array", items: { type: "object", properties: {} } },
        combo: {
          type: "object",
          // allOf sibling `enforced` has no parser counterpart → dead-schema.
          allOf: [{ type: "object", properties: { enforced: { type: "string" } } }],
          properties: { keep: { type: "string" } },
        },
        altBlock: {
          type: "object",
          // anyOf alternative `alt` is a shape the parser may not implement → absorbed.
          anyOf: [{ type: "object", properties: { alt: { type: "string" } } }],
        },
      },
    },
  });
  try {
    const result = fixture.run();
    const kinds = result.violations.map((v) => `${v.kind}:${v.key}`);
    assert.ok(kinds.includes("dead-schema:combo.enforced"), JSON.stringify(kinds));
    assert.equal(kinds.includes("dead-schema:altBlock.alt"), false, JSON.stringify(kinds));
  } finally {
    fixture.cleanup();
  }
});

test("map-shaped config: typed additionalProperties values are walked, not opaque, and dynamic maps are not false-flagged (#1990)", () => {
  const fixture = makeArrayFixtureRepo({
    configSchema: {
      properties: {
        parsedList: { type: "array", items: { type: "object", properties: { id: { type: "string" }, weight: { type: "number" } } } },
        passThroughList: { type: "array", items: { type: "object", properties: {} } },
        combo: { type: "object", properties: { keep: { type: "string" } } },
        // mapBlock is a dynamic-key map the parser hands through raw; its typed
        // value fields flatten under `*` but must NOT dead-schema-flag (no
        // statically parsed values under the map prefix).
        mapBlock: {
          type: "object",
          additionalProperties: { type: "object", properties: { enabled: { type: "boolean" }, weight: { type: "number" } } },
        },
      },
    },
  });
  try {
    const result = fixture.run();
    assert.equal(
      result.violations.some((v) => v.key.startsWith("mapBlock.")),
      false,
      JSON.stringify(result.violations),
    );
  } finally {
    fixture.cleanup();
  }
});

test("real repo surface is contract-clean against the committed grandfather manifest", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  // Surface-only check: the shrink-only ban is covered by the Git-fixture
  // tests above and must not couple this unit test to CI checkout depth.
  const result = runContractCheck({ repoRoot, checkGrandfatherBaseline: false });
  assert.deepEqual(
    result.violations,
    [],
    "new config-contract violations — fix the drift or grandfather with a tracking issue",
  );
  assert.deepEqual(
    result.staleGrandfatherEntries.map((entry) => `${entry.kind}:${entry.key}`),
    [],
    "stale grandfather entries — prune scripts/config-contract/grandfathered.json",
  );
});
