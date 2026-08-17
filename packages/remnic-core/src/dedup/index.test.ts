import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NEGATION_WORDS, findContradictions, findDuplicates } from "./index.js";

test("findContradictions detects can versus cannot statements", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-contradiction-"));

  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir);
    await writeFile(
      path.join(factsDir, "can.md"),
      ["---", "id: mem-can", "category: fact", "---", "The user can access production."].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(factsDir, "cannot.md"),
      ["---", "id: mem-cannot", "category: fact", "---", "The user cannot access production."].join("\n"),
      "utf8"
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
        ["---", `id: ${id}`, "category: fact", "---", content].join("\n"),
        "utf8"
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

test("dedup keeps duplicate and distinct pairs across Unicode scripts", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-unicode-"));

  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir);
    const entries = [
      ["english-a.md", "mem-english-a", "The user prefers tea."],
      ["english-b.md", "mem-english-b", "The user prefers tea"],
      ["english-c.md", "mem-english-c", "The user prefers coffee."],
      ["japanese-a.md", "mem-japanese-a", "利用者は紅茶を好む。"],
      ["japanese-b.md", "mem-japanese-b", "利用者は紅茶を好む。"],
      ["japanese-c.md", "mem-japanese-c", "利用者は珈琲を好む。"],
      ["korean-a.md", "mem-korean-a", "사용자는홍차를좋아한다"],
      ["korean-b.md", "mem-korean-b", "사용자는홍차를좋아한다"],
      ["korean-c.md", "mem-korean-c", "사용자는커피를좋아한다"],
      ["korean-punctuation.md", "mem-korean-punctuation", "홍차・커피"],
      ["korean-hyphen.md", "mem-korean-hyphen", "홍차-커피"],
      ["korean-joined.md", "mem-korean-joined", "홍차커피"],
      ["japanese-boundary-a.md", "mem-japanese-boundary-a", "甲・乙丙"],
      ["japanese-boundary-b.md", "mem-japanese-boundary-b", "甲乙・丙"],
    ] as const;

    for (const [fileName, id, content] of entries) {
      await writeFile(
        path.join(factsDir, fileName),
        ["---", `id: ${id}`, "category: fact", "---", content].join("\n"),
        "utf8"
      );
    }

    const result = findDuplicates({ memoryDir, categories: ["facts"] });

    assert.equal(result.scanned, entries.length);
    assert.equal(result.duplicates.length, 3);
    assert.deepEqual(result.duplicates.map(({ left, right }) => [left.id, right.id]).sort(), [
      ["mem-english-a", "mem-english-b"],
      ["mem-japanese-a", "mem-japanese-b"],
      ["mem-korean-a", "mem-korean-b"],
    ]);
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
      ["---", "id: outside", "category: fact", "---", "Outside memory should not be scanned."].join("\n"),
      "utf8"
    );
    await symlink(outsideDir, path.join(memoryDir, "facts"), "dir");

    assert.throws(() => findDuplicates({ memoryDir, categories: ["facts"] }), /symlinked memory category directory/);
    assert.throws(
      () => findContradictions({ memoryDir, categories: ["facts"] }),
      /symlinked memory category directory/
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("strip-negation pattern is derived from NEGATION_WORDS", async () => {
  NEGATION_WORDS.add("seldom");
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-dedup-negation-"));

  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir);
    await writeFile(
      path.join(factsDir, "plain.md"),
      ["---", "id: mem-plain", "category: fact", "---", "The user enjoys morning runs."].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(factsDir, "seldom.md"),
      ["---", "id: mem-seldom", "category: fact", "---", "The user seldom enjoys morning runs."].join("\n"),
      "utf8"
    );

    const result = findContradictions({ memoryDir, categories: ["facts"] });

    // "high" requires the stripped texts to match exactly, which only happens
    // when the strip pattern honors the word the test added to the set.
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0]?.severity, "high");
    assert.equal(result.contradictions[0]?.reason, "Negated version of similar content");
  } finally {
    NEGATION_WORDS.delete("seldom");
    await rm(memoryDir, { recursive: true, force: true });
  }
});
