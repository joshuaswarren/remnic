import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  expandTestPatterns,
  loadNativeManifest,
  parseTapSummary,
  partitionNativeDependent,
  probeBetterSqlite3,
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
