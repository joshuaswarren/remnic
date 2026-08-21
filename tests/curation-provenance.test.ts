import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { curate } from "../packages/remnic-core/src/curation/index.js";

test("single-file curation records the source filename as provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-curation-file-"));
  try {
    const sourceDir = path.join(root, "source-notes");
    const memoryDir = path.join(root, "memory");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "example.md");
    await writeFile(
      sourceFile,
      "The release checklist should always include rollback verification before launch.",
      "utf8",
    );

    const result = await curate({
      targetPath: sourceFile,
      memoryDir,
      checkDuplicates: false,
    });

    assert.equal(result.written.length, 1);
    const written = await readFile(result.written[0]!, "utf8");
    assert.match(written, /^provenanceFile: example\.md$/m);
    assert.doesNotMatch(written, /^provenanceFile:\s*$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory curation records paths relative to the target directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-curation-dir-"));
  try {
    const sourceDir = path.join(root, "source-notes");
    const nestedDir = path.join(sourceDir, "nested");
    const memoryDir = path.join(root, "memory");
    await mkdir(nestedDir, { recursive: true });
    const sourceFile = path.join(nestedDir, "example.md");
    await writeFile(
      sourceFile,
      "The support handoff should always mention the customer impact and next owner.",
      "utf8",
    );

    const result = await curate({
      targetPath: sourceDir,
      memoryDir,
      checkDuplicates: false,
    });

    assert.equal(result.written.length, 1);
    const written = await readFile(result.written[0]!, "utf8");
    assert.match(written, /^provenanceFile: nested\/example\.md$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("curation rejects when a memory write fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-curation-write-fail-"));
  const originalWriteFileSync = fs.writeFileSync;
  try {
    const sourceDir = path.join(root, "source-notes");
    const memoryDir = path.join(root, "memory");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "example.md");
    await writeFile(
      sourceFile,
      "The deploy notes should always include the verification command and result.",
      "utf8",
    );

    fs.writeFileSync = (() => {
      throw new Error("simulated write failure");
    }) as typeof fs.writeFileSync;

    await assert.rejects(
      () =>
        curate({
          targetPath: sourceFile,
          memoryDir,
          checkDuplicates: false,
        }),
      /simulated write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    await rm(root, { recursive: true, force: true });
  }
});
