import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SKIP_LIST_PATH,
  SMOKE_LIST_PATH,
  collectCoreTestFiles,
  formatSkipReport,
  parseSkipList,
  parseSmokeList,
  partitionSkipped,
} from "../scripts/windows-test-runner.mjs";

const ENTRY = {
  file: "packages/remnic-core/src/example.test.ts",
  issue: "#3034",
  reason: "native binding not built on windows yet",
};

test("the shipped skip list parses and every entry names a real file", () => {
  const entries = parseSkipList(JSON.parse(readFileSync(SKIP_LIST_PATH, "utf8")));
  const { stale } = partitionSkipped(collectCoreTestFiles(), entries);
  assert.deepEqual(
    stale,
    [],
    `scripts/windows-skip-list.json lists missing files: ${stale.map((e) => e.file).join(", ")}`
  );
});

test("an empty skip list skips nothing", () => {
  const files = ["packages/remnic-core/src/a.test.ts", "packages/remnic-core/src/b.test.ts"];
  const { run, skipped, stale } = partitionSkipped(files, parseSkipList({ skips: [] }));
  assert.deepEqual(run, files);
  assert.deepEqual(skipped, []);
  assert.deepEqual(stale, []);
  assert.match(formatSkipReport(skipped).join("\n"), /skip list is empty/);
});

test("a listed file is skipped and printed by name", () => {
  const files = [ENTRY.file, "packages/remnic-core/src/other.test.ts"];
  const { run, skipped, stale } = partitionSkipped(files, parseSkipList({ skips: [ENTRY] }));
  assert.deepEqual(run, ["packages/remnic-core/src/other.test.ts"]);
  assert.deepEqual(skipped, [ENTRY]);
  assert.deepEqual(stale, []);

  const report = formatSkipReport(skipped).join("\n");
  assert.ok(report.includes(ENTRY.file), "skip report must name the skipped file");
  assert.ok(report.includes(ENTRY.reason), "skip report must state the reason");
  assert.ok(report.includes(ENTRY.issue), "skip report must cite the issue");
});

test("an entry missing issue or reason is rejected", () => {
  const { issue: _issue, ...noIssue } = ENTRY;
  const { reason: _reason, ...noReason } = ENTRY;
  assert.throws(() => parseSkipList({ skips: [noIssue] }), /skips\[0\]\.issue is required/);
  assert.throws(() => parseSkipList({ skips: [noReason] }), /skips\[0\]\.reason is required/);
  assert.throws(() => parseSkipList({ skips: [{ ...ENTRY, file: "" }] }), /file is required/);
  assert.throws(
    () => parseSkipList({ skips: [{ ...ENTRY, issue: "someday" }] }),
    /must be "#<number>" or a github issue URL/
  );
  assert.throws(() => parseSkipList({ skips: [ENTRY, { ...ENTRY }] }), /duplicates an earlier entry/);
  assert.throws(() => parseSkipList({ skips: {} }), /"skips" must be an array/);
  assert.throws(() => parseSkipList([]), /must contain a JSON object/);
});

test("a listed path that no longer exists is reported, not ignored", () => {
  const { run, skipped, stale } = partitionSkipped(
    ["packages/remnic-core/src/other.test.ts"],
    parseSkipList({ skips: [ENTRY] })
  );
  assert.deepEqual(stale, [ENTRY]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(run, ["packages/remnic-core/src/other.test.ts"]);
});

test("collectCoreTestFiles returns sorted posix repo-relative test paths", () => {
  const files = collectCoreTestFiles();
  assert.ok(files.length > 0, "the core suite must not be empty");
  for (const file of files) {
    assert.ok(file.startsWith("packages/remnic-core/src/"), file);
    assert.ok(file.endsWith(".test.ts"), file);
    assert.ok(!file.includes("\\"), `path must be posix: ${file}`);
  }
  assert.deepEqual(files, [...files].sort());
});

test("the shipped smoke list parses and every entry names a real collected file", () => {
  const smokeFiles = parseSmokeList(JSON.parse(readFileSync(SMOKE_LIST_PATH, "utf8")));
  const collected = new Set(collectCoreTestFiles());
  const missing = smokeFiles.filter((file) => !collected.has(file));
  assert.deepEqual(
    missing,
    [],
    `scripts/windows-smoke-list.json lists missing files: ${missing.join(", ")}`
  );
});

test("parseSmokeList rejects shapes that would silently widen the subset", () => {
  const good = "packages/remnic-core/src/a.test.ts";
  assert.throws(() => parseSmokeList({ files: [] }), /"files" must be a non-empty array/);
  assert.throws(() => parseSmokeList({ files: {} }), /"files" must be a non-empty array/);
  assert.throws(() => parseSmokeList([]), /must contain a JSON object/);
  assert.throws(() => parseSmokeList({ files: ["src/a.test.ts"] }), /must live under packages\/remnic-core\/src/);
  assert.throws(() => parseSmokeList({ files: ["packages\\remnic-core\\src\\a.test.ts"] }), /repo-relative posix path/);
  assert.throws(() => parseSmokeList({ files: ["packages/remnic-core/src/../src/a.test.ts"] }), /repo-relative posix path/);
  assert.throws(() => parseSmokeList({ files: ["packages/remnic-core/src/a.ts"] }), /must name a \*\.test\.ts file/);
  assert.throws(() => parseSmokeList({ files: [good, good] }), /duplicates an earlier entry/);
  assert.deepEqual(parseSmokeList({ files: [good] }), [good]);
});
