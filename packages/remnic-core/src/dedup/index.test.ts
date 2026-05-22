import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findContradictions, findDuplicates } from "./index.js";

test("findContradictions detects can versus cannot statements", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-contradiction-"));

  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir);
    await writeFile(
      path.join(factsDir, "can.md"),
      [
        "---",
        "id: mem-can",
        "category: fact",
        "---",
        "The user can access production.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(factsDir, "cannot.md"),
      [
        "---",
        "id: mem-cannot",
        "category: fact",
        "---",
        "The user cannot access production.",
      ].join("\n"),
      "utf8",
    );

    const result = findContradictions({ memoryDir, categories: ["facts"] });

    assert.equal(result.scanned, 2);
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0]?.severity, "high");
    assert.equal(result.contradictions[0]?.reason, 'Opposite quantifiers: "can" vs "cannot"');
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("dedup public numeric options are normalized before scanning", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-options-"));

  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir);
    for (const [fileName, id, content] of [
      ["a.md", "mem-a", "The user prefers short status updates."],
      ["b.md", "mem-b", "The user prefers short status updates."],
    ] as const) {
      await writeFile(
        path.join(factsDir, fileName),
        [
          "---",
          `id: ${id}`,
          "category: fact",
          "---",
          content,
        ].join("\n"),
        "utf8",
      );
    }

    const invalidThreshold = findDuplicates({
      memoryDir,
      categories: ["facts"],
      threshold: Number.NaN,
    });
    assert.equal(invalidThreshold.scanned, 2);
    assert.equal(invalidThreshold.duplicates.length, 1);

    const zeroMaxLoad = findDuplicates({
      memoryDir,
      categories: ["facts"],
      maxLoad: 0,
    });
    assert.equal(zeroMaxLoad.scanned, 0);

    const invalidMaxLoad = findContradictions({
      memoryDir,
      categories: ["facts"],
      maxLoad: 0.5,
    });
    assert.equal(invalidMaxLoad.scanned, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("dedup scans reject symlinked category directories outside memoryDir", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-root-"));
  const outsideDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-outside-"));

  try {
    await writeFile(
      path.join(outsideDir, "outside.md"),
      [
        "---",
        "id: outside",
        "category: fact",
        "---",
        "Outside memory should not be scanned.",
      ].join("\n"),
      "utf8",
    );
    await symlink(outsideDir, path.join(memoryDir, "facts"), "dir");

    assert.throws(
      () => findDuplicates({ memoryDir, categories: ["facts"] }),
      /symlinked memory category directory/,
    );
    assert.throws(
      () => findContradictions({ memoryDir, categories: ["facts"] }),
      /symlinked memory category directory/,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
