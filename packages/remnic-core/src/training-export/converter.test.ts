import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { convertMemoriesToRecords, readContainedMarkdownFile } from "./converter.js";

// ---------------------------------------------------------------------------
// Helper: create a synthetic memory file
// ---------------------------------------------------------------------------

interface SyntheticMemory {
  id: string;
  category?: string;
  confidence?: number;
  created?: string;
  tags?: string[];
  content: string;
}

async function writeSyntheticMemory(
  dir: string,
  subdir: string,
  filename: string,
  mem: SyntheticMemory,
): Promise<void> {
  const fullDir = path.join(dir, subdir);
  await mkdir(fullDir, { recursive: true });
  const tags = mem.tags ?? [];
  const md = [
    "---",
    `id: ${mem.id}`,
    `category: ${mem.category ?? "fact"}`,
    `created: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `updated: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `source: test`,
    `confidence: ${mem.confidence ?? 0.9}`,
    `confidenceTier: explicit`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    mem.content,
  ].join("\n");
  await writeFile(path.join(fullDir, filename), md, "utf-8");
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-training-export-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("convertMemoriesToRecords", () => {
  it("converts memory files to records", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem-001.md", {
      id: "mem-001",
      content: "TypeScript is a typed superset of JavaScript.",
      tags: ["typescript", "language"],
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.equal(records[0].output, "TypeScript is a typed superset of JavaScript.");
    assert.equal(records[0].input, "");
    assert.match(records[0].instruction, /factual memory/);
    assert.equal(records[0].category, "fact");
    assert.equal(records[0].confidence, 0.9);
    assert.deepEqual(records[0].sourceIds, ["mem-001"]);
  });

  it("filters by minConfidence", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "high.md", {
      id: "high",
      confidence: 0.95,
      content: "High confidence fact.",
    });
    await writeSyntheticMemory(dir, "facts", "low.md", {
      id: "low",
      confidence: 0.3,
      content: "Low confidence fact.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      minConfidence: 0.5,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "high");
  });

  it("filters by categories", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "fact.md", {
      id: "f1",
      category: "fact",
      content: "A fact.",
    });
    await writeSyntheticMemory(dir, "corrections", "corr.md", {
      id: "c1",
      category: "correction",
      content: "A correction.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      categories: ["correction"],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].category, "correction");
  });

  it("filters by date range (since/until) with half-open semantics", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "old.md", {
      id: "old",
      created: "2025-06-01T00:00:00.000Z",
      content: "Old memory.",
    });
    await writeSyntheticMemory(dir, "facts", "mid.md", {
      id: "mid",
      created: "2026-01-15T00:00:00.000Z",
      content: "Mid memory.",
    });
    await writeSyntheticMemory(dir, "facts", "new.md", {
      id: "new",
      created: "2026-03-01T00:00:00.000Z",
      content: "New memory.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2026-01-01T00:00:00.000Z"),
      until: new Date("2026-02-01T00:00:00.000Z"),
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "mid");
  });

  it("until filter uses exclusive upper bound (CLAUDE.md #35)", async () => {
    const dir = await makeTmpDir();
    const boundaryDate = "2026-02-01T00:00:00.000Z";
    await writeSyntheticMemory(dir, "facts", "boundary.md", {
      id: "boundary",
      created: boundaryDate,
      content: "Boundary memory.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      until: new Date(boundaryDate),
    });

    // Exact boundary should be excluded (half-open: created < until)
    assert.equal(records.length, 0);
  });

  it("excludes memories with missing dates when date filters are active", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "dated.md", {
      id: "dated",
      created: "2026-01-15T00:00:00.000Z",
      content: "Memory with a valid date.",
    });
    // Write a memory with no created date (empty string in frontmatter)
    await mkdir(path.join(dir, "facts"), { recursive: true });
    const noDateMd = [
      "---",
      "id: no-date",
      "category: fact",
      "created: ",
      "updated: ",
      "source: test",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "tags: []",
      "---",
      "",
      "Memory with no date.",
    ].join("\n");
    await writeFile(path.join(dir, "facts", "no-date.md"), noDateMd, "utf-8");

    // With a since filter, dateless memory should be excluded
    const withSince = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2025-01-01T00:00:00.000Z"),
    });
    assert.equal(withSince.length, 1);
    assert.equal(withSince[0].sourceIds?.[0], "dated");

    // With an until filter, dateless memory should be excluded
    const withUntil = await convertMemoriesToRecords({
      memoryDir: dir,
      until: new Date("2027-01-01T00:00:00.000Z"),
    });
    assert.equal(withUntil.length, 1);
    assert.equal(withUntil[0].sourceIds?.[0], "dated");

    // Without date filters, dateless memory should be included
    const noFilter = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(noFilter.length, 2);
  });

  it("excludes memories with overflowed calendar dates when date filters are active", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "overflow.md", {
      id: "overflow",
      created: "2026-02-31T00:00:00Z",
      content: "Memory with an overflowed date.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2026-03-01T00:00:00.000Z"),
    });

    assert.deepEqual(records, []);
  });

  it("handles empty memory directory", async () => {
    const dir = await makeTmpDir();
    // Don't create any subdirectories
    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("handles malformed memory files gracefully", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });
    // Write a file with no frontmatter
    await writeFile(
      path.join(dir, "facts", "broken.md"),
      "This file has no YAML frontmatter at all.",
      "utf-8",
    );

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("skips files with empty content body", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });
    const md = ["---", "id: empty", "category: fact", "confidence: 0.9", "---", ""].join("\n");
    await writeFile(path.join(dir, "facts", "empty.md"), md, "utf-8");

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("includes entities directory when includeEntities is true", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "entities", "person-alice.md", {
      id: "entity-1",
      category: "entity",
      content: "Alice is a software engineer.",
    });

    // Without includeEntities — should not find entity
    const withoutEntities = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(withoutEntities.length, 0);

    // With includeEntities — should find entity
    const withEntities = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    assert.equal(withEntities.length, 1);
    assert.equal(withEntities[0].category, "entity");
  });

  it("reads from nested subdirectories", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts/nested/deep", "deep.md", {
      id: "deep",
      content: "Deeply nested memory.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "deep");
  });

  it("builds category-specific instructions", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "corrections", "pref.md", {
      id: "pref",
      category: "preference",
      content: "Prefers dark mode.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.match(records[0].instruction, /user preference/);
  });

  // --- Security: symlink traversal must be blocked ---

  it("refuses to follow .md symlinks pointing outside memoryDir", async () => {
    const dir = await makeTmpDir();

    // Write one legitimate fact file.
    await writeSyntheticMemory(dir, "facts", "real.md", {
      id: "real",
      content: "Real memory.",
    });

    // Create a sensitive file OUTSIDE the memoryDir.
    const outsideDir = await makeTmpDir();
    const secretPath = path.join(outsideDir, "secret.md");
    const secretMd = [
      "---",
      "id: secret",
      "category: fact",
      "confidence: 0.99",
      "tags: []",
      "---",
      "",
      "EXFILTRATED SECRET CONTENT",
    ].join("\n");
    await writeFile(secretPath, secretMd, "utf-8");

    // Plant a .md symlink inside facts/ that points at the outside file.
    const factsDir = path.join(dir, "facts");
    const linkPath = path.join(factsDir, "leak.md");
    try {
      await symlink(secretPath, linkPath);
    } catch {
      // Symlinks may be unavailable (e.g. non-privileged Windows). Skip.
      return;
    }

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1, "only the real, non-symlinked memory should be exported");
    assert.equal(records[0].sourceIds?.[0], "real");
    for (const r of records) {
      assert.doesNotMatch(r.output, /EXFILTRATED/);
    }
  });

  it("refuses to open a symlink swapped into a previously validated markdown path", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "race.md", {
      id: "race",
      content: "Original memory.",
    });
    const filePath = path.join(dir, "facts", "race.md");
    const containmentRoot = await realpath(dir);

    const outsideDir = await makeTmpDir();
    const secretPath = path.join(outsideDir, "secret.md");
    await writeFile(
      secretPath,
      [
        "---",
        "id: secret",
        "category: fact",
        "confidence: 0.99",
        "tags: []",
        "---",
        "",
        "EXFILTRATED SECRET CONTENT",
      ].join("\n"),
      "utf-8",
    );

    try {
      await rm(filePath);
      await symlink(secretPath, filePath);
    } catch {
      return; // symlinks unavailable
    }

    const raw = await readContainedMarkdownFile(filePath, containmentRoot);
    assert.equal(raw, null);
  });

  it("refuses to descend into directory symlinks that escape memoryDir", async () => {
    const dir = await makeTmpDir();
    const outsideDir = await makeTmpDir();

    // Plant a sensitive memory in the outside directory.
    await mkdir(path.join(outsideDir, "facts"), { recursive: true });
    await writeFile(
      path.join(outsideDir, "facts", "secret.md"),
      [
        "---",
        "id: secret",
        "category: fact",
        "confidence: 0.99",
        "tags: []",
        "---",
        "",
        "EXFILTRATED SECRET CONTENT",
      ].join("\n"),
      "utf-8",
    );

    // Create a symlinked `facts` dir inside memoryDir pointing outside.
    try {
      await symlink(path.join(outsideDir, "facts"), path.join(dir, "facts"));
    } catch {
      return; // symlinks unavailable
    }

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    for (const r of records) {
      assert.doesNotMatch(r.output, /EXFILTRATED/);
    }
  });

  it("produces a descriptive instruction for personal category", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "personal.md", {
      id: "p1",
      category: "personal",
      content: "Something personal.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    // Must NOT fall through to the generic "Recall a memory" default.
    assert.match(records[0].instruction, /personal information/);
  });

  it("refuses to export .md files that have multiple hard links (nlink > 1)", async () => {
    const dir = await makeTmpDir();
    const outsideDir = await makeTmpDir();

    // Write a secret file outside memoryDir, then hard-link it into memoryDir.
    const secretPath = path.join(outsideDir, "secret.md");
    await writeFile(
      secretPath,
      [
        "---",
        "id: secret",
        "category: fact",
        "confidence: 0.99",
        "tags: []",
        "---",
        "",
        "EXFILTRATED SECRET CONTENT",
      ].join("\n"),
      "utf-8",
    );
    await mkdir(path.join(dir, "facts"), { recursive: true });
    try {
      await link(secretPath, path.join(dir, "facts", "leak.md"));
    } catch {
      // Hard links across filesystems (EXDEV) or on systems without link
      // support are not testable here; skip in that case.
      return;
    }

    // Also write a normal, single-link memory so we can confirm the pipeline
    // still processes legitimate files.
    await writeSyntheticMemory(dir, "facts", "normal.md", {
      id: "normal",
      content: "Normal memory.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    for (const r of records) {
      assert.doesNotMatch(r.output, /EXFILTRATED/);
    }
    // The single-link memory must still be exported.
    assert.ok(
      records.some((r) => r.sourceIds?.[0] === "normal"),
      "legitimate (single-link) memory must still be exported",
    );
  });

  // --- Determinism: output order must not depend on readdir ordering ---

  it("produces deterministic ordering across invocations", async () => {
    const dir = await makeTmpDir();
    // Create files in non-lexicographic creation order.
    const names = ["c.md", "a.md", "b.md"];
    for (const n of names) {
      await writeSyntheticMemory(dir, "facts", n, {
        id: n.replace(".md", ""),
        content: `Memory ${n}`,
      });
    }

    const first = await convertMemoriesToRecords({ memoryDir: dir });
    const second = await convertMemoriesToRecords({ memoryDir: dir });

    assert.deepEqual(
      first.map((r) => r.sourceIds?.[0]),
      second.map((r) => r.sourceIds?.[0]),
      "ordering must be stable across runs",
    );
    // Should be sorted lexicographically.
    assert.deepEqual(
      first.map((r) => r.sourceIds?.[0]),
      ["a", "b", "c"],
    );
  });
});
