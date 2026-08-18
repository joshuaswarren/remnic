import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isGenericRecallExcludedPath } from "../orchestration/generic-recall-paths.js";
import { parseOkfConfig } from "./config.js";
import { OKF_INDEX_MARKER, runOkfIndexMaintenance } from "./index-files.js";

function store(): string {
  const root = mkdtempSync(path.join(tmpdir(), "okf-index-"));
  mkdirSync(path.join(root, "facts", "2026-01-02"), { recursive: true });
  writeFileSync(
    path.join(root, "facts", "2026-01-02", "fact-1.md"),
    "---\nid: fact-1\ncategory: fact\n---\nPostgres is the store.\n",
  );
  return root;
}

test("parseOkfConfig defaults indexFilesEnabled off", () => {
  assert.equal(parseOkfConfig(undefined).indexFilesEnabled, false);
  assert.equal(parseOkfConfig({ indexFilesEnabled: "false" }).indexFilesEnabled, false);
  assert.equal(parseOkfConfig({ indexFilesEnabled: true }).indexFilesEnabled, true);
});

test("flag off writes nothing", async () => {
  const root = store();
  const report = await runOkfIndexMaintenance(root, false);
  assert.deepEqual(report.written, []);
  assert.throws(() => readFileSync(path.join(root, "facts", "2026-01-02", "index.md")));
});

test("flag on writes a deterministic generated index", async () => {
  const root = store();
  const first = await runOkfIndexMaintenance(root, true);
  const second = await runOkfIndexMaintenance(root, true);
  const file = path.join(root, "facts", "2026-01-02", "index.md");
  assert.equal(first.written.length, 1);
  assert.equal(second.written.length, 0);
  const body = readFileSync(file, "utf8");
  assert.match(body, new RegExp(OKF_INDEX_MARKER));
  assert.match(body, /fact-1\.md/);
});

test("disable removes generated indexes and keeps user files", async () => {
  const root = store();
  await runOkfIndexMaintenance(root, true);
  const user = path.join(root, "facts", "index.md");
  writeFileSync(user, "# mine\n");
  const report = await runOkfIndexMaintenance(root, false);
  assert.ok(report.removed.some((item) => item.endsWith(`${path.sep}2026-01-02${path.sep}index.md`)));
  assert.equal(readFileSync(user, "utf8"), "# mine\n");
});

test("reserved OKF basenames are excluded from generic recall", () => {
  assert.equal(isGenericRecallExcludedPath("facts/2026-01-02/index.md"), true);
  assert.equal(isGenericRecallExcludedPath("log.md"), true);
  assert.equal(isGenericRecallExcludedPath("facts/2026-01-02/fact-1.md"), false);
});
