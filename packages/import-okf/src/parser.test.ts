import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOkfBundle } from "./parser.js";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "okf-import-"));
  writeFileSync(
    path.join(root, "note.md"),
    `---\nid: fact-1\ntype: Memory Fact\ntimestamp: 2026-01-02T00:00:00.000Z\n---\nPostgres is the store.\n`,
  );
  writeFileSync(path.join(root, "index.md"), "---\ntype: Index\n---\nskip\n");
  mkdirSync(path.join(root, "nested"));
  writeFileSync(
    path.join(root, "nested", "decision.md"),
    `---\ntype: Decision\n---\nUse QMD.\n`,
  );
  return root;
}

test("parseOkfBundle reads markdown docs and skips reserved names", () => {
  const parsed = parseOkfBundle(fixture());
  assert.equal(parsed.documents.length, 2);
  assert.equal(parsed.documents[0]?.category, "decision");
  assert.equal(parsed.documents[1]?.sourceId, "fact-1");
  assert.equal(parsed.documents[1]?.content, "Postgres is the store.");
});

test("parseOkfBundle rejects archives and missing paths", () => {
  assert.throws(() => parseOkfBundle("bundle.zip"), /unpack first/);
  assert.throws(() => parseOkfBundle("bundle.tar.gz"), /unpack first/);
  assert.throws(() => parseOkfBundle(""), /directory path/);
});
