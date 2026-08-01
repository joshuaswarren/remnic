import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TEST_PATTERNS,
  TEST_PATTERN_GROUPS,
  chunkArgsByLength,
  expandTestPatterns,
  loadNativeManifest,
  parseRunnerArgs,
  parseTapSummary,
  partitionNativeDependent,
  probeBetterSqlite3,
  selectTestPatterns,
  selectTestShard,
} from "../scripts/root-test-runner-lib.mjs";

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "runner-lib-"));
  const write = (rel) => {
    const full = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "// fixture\n");
  };
  write("tests/a.test.ts");
  write("tests/nested/b.test.mjs");
  write("packages/core/src/c.test.ts");
  write("packages/core/src/deep/d.test.tsx");
  write("dashboard/lib/e.test.ts");
  write("integrations/amb/f.test.mjs");
  // Hook runners are CommonJS and live outside `<pkg>/src`.
  write("packages/plugin-x/hooks/bin/g.test.cjs");
  // Distractors that must NOT match.
  write("tests/not-a-test.ts");
  write("packages/core/lib/outside-src.test.ts");
  write("dashboard/lib/nested/too-deep.test.ts");
  return root;
}

test("expandTestPatterns matches every pattern shape and nothing else", () => {
  const root = makeTree();
  try {
    const { files, emptyPatterns } = expandTestPatterns(root);
    assert.deepEqual(emptyPatterns, []);
    assert.deepEqual(files, [
      "dashboard/lib/e.test.ts",
      "integrations/amb/f.test.mjs",
      "packages/core/src/c.test.ts",
      "packages/core/src/deep/d.test.tsx",
      "packages/plugin-x/hooks/bin/g.test.cjs",
      "tests/a.test.ts",
      "tests/nested/b.test.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expandTestPatterns reports vacuous patterns instead of passing silently", () => {
  const root = makeTree();
  try {
    rmSync(path.join(root, "integrations"), { recursive: true, force: true });
    const { emptyPatterns } = expandTestPatterns(root);
    assert.deepEqual(emptyPatterns, ["integrations/amb/*.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partitionNativeDependent splits, and flags stale manifest entries", () => {
  const files = ["tests/a.test.ts", "tests/lcm.test.ts"];
  const { run, excluded, stale } = partitionNativeDependent(files, [
    "tests/lcm.test.ts",
    "tests/gone.test.ts",
  ]);
  assert.deepEqual(run, ["tests/a.test.ts"]);
  assert.deepEqual(excluded, ["tests/lcm.test.ts"]);
  assert.deepEqual(stale, ["tests/gone.test.ts"]);
});

test("loadNativeManifest validates shape and rejects malformed payloads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-manifest-"));
  const manifestPath = path.join(root, "m.json");
  try {
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: ["b.ts", "a.ts"] }));
    assert.deepEqual(loadNativeManifest(manifestPath).files, ["a.ts", "b.ts"]);

    writeFileSync(manifestPath, "null");
    assert.throws(() => loadNativeManifest(manifestPath), /must be a JSON object/);
    writeFileSync(manifestPath, JSON.stringify({ version: 2, files: [] }));
    assert.throws(() => loadNativeManifest(manifestPath), /unsupported manifest version/);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: [3] }));
    assert.throws(() => loadNativeManifest(manifestPath), /array of strings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseTapSummary reads the epilogue and returns null without one", () => {
  const output = [
    "ok 1 - something",
    "# tests 12",
    "# suites 2",
    "# pass 11",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 5",
  ].join("\n");
  assert.deepEqual(parseTapSummary(output), {
    tests: 12,
    pass: 11,
    fail: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.equal(parseTapSummary("ok 1 - no summary here"), null);
});

test("chunkArgsByLength keeps every spawn under the budget without dropping args", () => {
  const args = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
  const chunks = chunkArgsByLength(args, 10);
  // Each arg costs length+1 = 5, so two fit per 10-char chunk.
  assert.deepEqual(chunks, [["aaaa", "bbbb"], ["cccc", "dddd"], ["eeee"]]);
  assert.deepEqual(chunks.flat(), args);

  // A single oversized argument still gets its own chunk.
  assert.deepEqual(chunkArgsByLength(["x".repeat(50)], 10), [["x".repeat(50)]]);
  // Empty input produces no chunks.
  assert.deepEqual(chunkArgsByLength([], 10), []);
  // Invalid budgets are rejected loudly.
  assert.throws(() => chunkArgsByLength(["a"], 0), /positive integer/);
});

test("probeBetterSqlite3 honours the forced-unavailable test seam", () => {
  const result = probeBetterSqlite3(process.cwd(), { REMNIC_FORCE_NATIVE_UNAVAILABLE: "1" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forced unavailable/);
});

test("probeBetterSqlite3 fails cleanly on a tree with no binding", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-probe-"));
  try {
    mkdirSync(path.join(root, "packages", "remnic-core"), { recursive: true });
    writeFileSync(
      path.join(root, "packages", "remnic-core", "package.json"),
      JSON.stringify({ name: "probe-fixture" }),
    );
    const result = probeBetterSqlite3(root, {});
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TEST_PATTERN_GROUPS is an exact partition of TEST_PATTERNS", () => {
  const grouped = Object.values(TEST_PATTERN_GROUPS).flat();
  const groupedSet = new Set(grouped);
  assert.equal(grouped.length, groupedSet.size, "a pattern id appears in more than one group");
  assert.deepEqual(
    [...groupedSet].sort(),
    TEST_PATTERNS.map((pattern) => pattern.id).sort(),
    "groups must cover every TEST_PATTERNS id and nothing else",
  );
});

test("selectTestPatterns with no groups returns the full pattern list", () => {
  assert.deepEqual(selectTestPatterns([]), TEST_PATTERNS);
});

test("selectTestPatterns filters to the requested groups only", () => {
  const selected = selectTestPatterns(["packages"]);
  assert.deepEqual(
    selected.map((pattern) => pattern.id),
    ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "packages/**/*.test.cjs"],
  );
  const combined = selectTestPatterns(["root", "misc"]);
  assert.deepEqual(
    combined.map((pattern) => pattern.id).sort(),
    [
      "dashboard/lib/*.test.ts",
      "integrations/amb/*.test.mjs",
      "tests/**/*.test.mjs",
      "tests/**/*.test.ts",
    ],
  );
});

test("selectTestPatterns rejects unknown group names", () => {
  assert.throws(() => selectTestPatterns(["nope"]), /Unknown test group "nope"/);
  assert.throws(() => selectTestPatterns("root"), /must be an array/);
});

test("parseRunnerArgs parses repeatable groups and one shard", () => {
  assert.deepEqual(parseRunnerArgs([]), { groups: [], shard: null });
  assert.deepEqual(parseRunnerArgs(["--group", "root"]), { groups: ["root"], shard: null });
  assert.deepEqual(
    parseRunnerArgs(["--group", "root", "--shard", "2/3", "--group", "misc", "--group", "root"]),
    { groups: ["root", "misc"], shard: { index: 2, total: 3 } },
  );
});

test("parseRunnerArgs rejects unknown, missing, duplicate, and malformed arguments", () => {
  assert.throws(() => parseRunnerArgs(["root"]), /Unknown argument "root"/);
  assert.throws(() => parseRunnerArgs(["--group"]), /requires a group name/);
  assert.throws(() => parseRunnerArgs(["--group", "--group"]), /requires a group name/);
  assert.throws(() => parseRunnerArgs(["--shard"]), /requires an index\/total argument/);
  assert.throws(() => parseRunnerArgs(["--shard", "0/2"]), /must satisfy 1 <= index <= total/);
  assert.throws(() => parseRunnerArgs(["--shard", "3/2"]), /must satisfy 1 <= index <= total/);
  assert.throws(() => parseRunnerArgs(["--shard", "1/0"]), /must satisfy 1 <= index <= total/);
  assert.throws(() => parseRunnerArgs(["--shard", "one/two"]), /must use index\/total/);
  assert.throws(() => parseRunnerArgs(["--shard", "1/2", "--shard", "2/2"]), /may be provided only once/);
});

test("selectTestShard deterministically partitions every file exactly once", () => {
  const files = ["e.test.ts", "a.test.ts", "d.test.ts", "b.test.ts", "c.test.ts"];
  assert.deepEqual(selectTestShard(files, { index: 1, total: 2 }), [
    "a.test.ts",
    "c.test.ts",
    "e.test.ts",
  ]);
  assert.deepEqual(selectTestShard(files, { index: 2, total: 2 }), ["b.test.ts", "d.test.ts"]);
});

test("selectTestShard rejects vacuous and invalid selections", () => {
  assert.throws(() => selectTestShard(["one"], { index: 1, total: 2 }), /would create an empty shard/);
  assert.throws(() => selectTestShard([], { index: 1, total: 1 }), /requires at least one file/);
  assert.throws(() => selectTestShard(["one"], { index: 0, total: 1 }), /invalid shard/);
});
