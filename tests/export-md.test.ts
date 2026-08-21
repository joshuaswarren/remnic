import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir, writeSensitiveTransferFixtureEntries } from "./transfer-fixtures.js";
import { exportMarkdownBundle } from "../src/transfer/export-md.js";

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

test("v2.3 md export copies files and writes a manifest", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  await exportMarkdownBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as any;
  assert.equal(manifest.format, "openclaw-engram-export");
  assert.ok(Array.isArray(manifest.files));

  const fact = await readFile(path.join(outDir, "facts", "2026-02-11", "fact-1.md"), "utf-8");
  assert.match(fact, /pianos/);
});

test("md export excludes secure store, capsules, VCS, and dependencies", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  await writeSensitiveTransferFixtureEntries(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  await exportMarkdownBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as {
    files: Array<{ path: string }>;
  };
  const paths = manifest.files.map((file) => file.path);
  assert.equal(paths.some((entry) => entry.startsWith(".secure-store/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".capsules/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".git/")), false);
  assert.equal(paths.some((entry) => entry.startsWith("node_modules/")), false);
  assert.ok(paths.includes("facts/2026-02-11/fact-1.md"));

  await assertPathMissing(path.join(outDir, ".secure-store", "header.json"));
  await assertPathMissing(path.join(outDir, ".capsules", "old.capsule.json.gz"));
  await assertPathMissing(path.join(outDir, ".git", "config"));
  await assertPathMissing(path.join(outDir, "node_modules", "pkg", "index.js"));
});

test("md export rejects output directory equal to memory directory", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  await assert.rejects(
    exportMarkdownBundle({ memoryDir: memDir, outDir: memDir, pluginVersion: "2.2.3" }),
    /output path must not equal the memory directory/,
  );
});
