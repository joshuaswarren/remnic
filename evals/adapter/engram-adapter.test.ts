import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeEvalQmdCollection } from "./engram-adapter.ts";

test("removeEvalQmdCollection removes the configured eval collection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-eval-qmd-cleanup-"));
  const logPath = path.join(dir, "qmd-args.log");
  const fakeQmdPath = path.join(dir, "qmd");
  await writeFile(
    fakeQmdPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeQmdPath, 0o700);

  try {
    const removed = await removeEvalQmdCollection({
      qmdEnabled: true,
      qmdCollection: "engram-eval-test-collection",
      qmdPath: fakeQmdPath,
    });

    assert.equal(removed, true);
    assert.equal(
      (await readFile(logPath, "utf8")).trim(),
      "collection remove engram-eval-test-collection",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeEvalQmdCollection skips cleanup when QMD is disabled", async () => {
  const removed = await removeEvalQmdCollection({
    qmdEnabled: false,
    qmdCollection: "engram-eval-test-collection",
    qmdPath: "/path/that/must/not/run",
  });

  assert.equal(removed, false);
});
