import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { listMemoryMarkdownFilePaths } from "../src/cli.js";

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
