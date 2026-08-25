import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { listMemoryMarkdownFilePaths } from "@remnic/core/cli";

// The shared CLI memory walker (walkMemoryMarkdownFiles, exposed here via
// listMemoryMarkdownFilePaths) must cover every recall category directory, not
// just facts/ + corrections/ — otherwise CLI commands built on it (bulk-import
// counting, dedupe, ...) would miss memories routed into decisions/,
// preferences/, ... after issue #1546.
test("listMemoryMarkdownFilePaths returns files under category dirs beyond facts/ (issue #1546)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-walk-category-"));
  try {
    const decisionDir = path.join(memoryDir, "decisions", "2026-02-22");
    await mkdir(decisionDir, { recursive: true });
    const decisionPath = path.join(decisionDir, "decision-1.md");
    await writeFile(
      decisionPath,
      ["---", "id: decision-1", "category: decision", "---", "We chose blue-green deploys."].join("\n"),
      "utf-8",
    );

    const factDir = path.join(memoryDir, "facts", "2026-02-22");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-1.md");
    await writeFile(
      factPath,
      ["---", "id: fact-1", "category: fact", "---", "The worker retries three times."].join("\n"),
      "utf-8",
    );

    const paths = (await listMemoryMarkdownFilePaths(memoryDir)).sort();
    assert.deepEqual(paths, [decisionPath, factPath].sort());
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Security regression (codex P2): the walker feeds readAllMemoryFiles →
// dedupe-exact/dedupe-aggressive, which unlink() files. A category root
// symlinked outside memoryDir must NOT be followed, or dedupe could delete
// markdown outside the memory store. Mirrors scanDir's containment guard.
test("listMemoryMarkdownFilePaths does not follow a category root symlinked outside memoryDir", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-walk-escape-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-walk-outside-"));
  try {
    // A file OUTSIDE the memory store that must never be returned.
    await writeFile(
      path.join(outsideDir, "evil.md"),
      ["---", "id: evil", "category: decision", "---", "External file — must not be walked."].join("\n"),
      "utf-8",
    );
    // decisions/ is a symlink pointing at the external dir.
    await symlink(outsideDir, path.join(memoryDir, "decisions"), "dir");

    // A legitimate memory under a real category dir — regression that normal
    // walking still works alongside the rejected symlink.
    const realDir = path.join(memoryDir, "facts", "2026-02-22");
    await mkdir(realDir, { recursive: true });
    const realPath = path.join(realDir, "real.md");
    await writeFile(
      realPath,
      ["---", "id: real", "category: fact", "---", "A genuine in-store memory."].join("\n"),
      "utf-8",
    );

    const paths = await listMemoryMarkdownFilePaths(memoryDir);

    assert.deepEqual(
      paths.filter((p) => p.endsWith("evil.md")),
      [],
      "must not walk into a symlinked category root that escapes memoryDir",
    );
    assert.deepEqual(paths, [realPath], "the real in-store memory is still returned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// A dated subdir under a real category dir that is itself a symlink escaping
// memoryDir must also be skipped (nested-entry containment).
test("listMemoryMarkdownFilePaths skips a nested subdir symlink that escapes memoryDir", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-walk-nested-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-walk-nested-outside-"));
  try {
    await writeFile(
      path.join(outsideDir, "evil.md"),
      ["---", "id: evil-nested", "category: decision", "---", "External — must not be walked."].join("\n"),
      "utf-8",
    );
    const decisionsDir = path.join(memoryDir, "decisions");
    await mkdir(decisionsDir, { recursive: true });
    // decisions/escape → outside dir (a nested entry, not the root).
    await symlink(outsideDir, path.join(decisionsDir, "escape"), "dir");

    const realPath = path.join(decisionsDir, "2026-02-22", "real.md");
    await mkdir(path.dirname(realPath), { recursive: true });
    await writeFile(
      realPath,
      ["---", "id: real-nested", "category: decision", "---", "Genuine decision memory."].join("\n"),
      "utf-8",
    );

    const paths = await listMemoryMarkdownFilePaths(memoryDir);
    assert.deepEqual(
      paths.filter((p) => p.endsWith("evil.md")),
      [],
      "must not follow a nested symlinked subdir that escapes memoryDir",
    );
    assert.deepEqual(paths, [realPath], "the real nested memory is still returned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
