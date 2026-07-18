import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { runContractCheck } from "../scripts/config-contract/contract-check.ts";

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
          properties: { enabled: { type: "boolean" } },
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
          /^parser\.ts:\d+$/.test(v.key) &&
          v.detail.length > 0,
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

test("real repo surface is contract-clean against the committed grandfather manifest", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const result = runContractCheck({ repoRoot });
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
