import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJsonBundle } from "../src/transfer/export-json.js";
import { importJsonBundle } from "../src/transfer/import-json.js";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

async function writeJsonBundle(
  outDir: string,
  records: Array<{ path: string; content: string }>,
): Promise<void> {
  const manifest = {
    format: "openclaw-engram-export",
    schemaVersion: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    pluginVersion: "test",
    includesTranscripts: false,
    files: records.map((record) => ({
      path: record.path,
      sha256: "test",
      bytes: Buffer.byteLength(record.content),
    })),
  };

  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest),
    "utf-8",
  );
  await writeFile(
    path.join(outDir, "bundle.json"),
    JSON.stringify({ manifest, records }),
    "utf-8",
  );
}

test("v2.3 json export/import round-trips (without transcripts by default)", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await exportJsonBundle({
    memoryDir: memDir,
    outDir,
    includeTranscripts: false,
    pluginVersion: "2.2.3",
  });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as any;
  assert.equal(manifest.includesTranscripts, false);
  assert.ok(Array.isArray(manifest.files));

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const res = await importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir, conflict: "skip" });
  assert.ok(res.written > 0);

  const importedProfile = await readFile(path.join(targetDir, "profile.md"), "utf-8");
  assert.match(importedProfile, /Prefers concise/);

  const fact = await readFile(path.join(targetDir, "facts", "2026-02-11", "fact-1.md"), "utf-8");
  assert.match(fact, /The user likes pianos/);
});

test("json import rejects memory records that escape the target directory", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));
  const outsidePath = path.join(outsideDir, "outside.md");

  await writeJsonBundle(outDir, [
    {
      path: `../${path.basename(outsideDir)}/outside.md`,
      content: "escaped",
    },
  ]);

  await assert.rejects(
    importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir }),
    /unsafe segments|escapes target root/i,
  );
  await assertPathMissing(outsidePath);
});

test("json import rejects workspace records that escape the workspace directory", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-workspace-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-workspace-outside-"));
  const outsidePath = path.join(outsideDir, "outside.md");

  await writeJsonBundle(outDir, [
    {
      path: `workspace/../${path.basename(outsideDir)}/outside.md`,
      content: "escaped",
    },
  ]);

  await assert.rejects(
    importJsonBundle({
      targetMemoryDir: targetDir,
      fromDir: outDir,
      workspaceDir,
    }),
    /unsafe segments|escapes target root/i,
  );
  await assertPathMissing(outsidePath);
});

test("json import rejects paths whose existing parent is a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));
  const outsidePath = path.join(outsideDir, "secret.md");
  await symlink(outsideDir, path.join(targetDir, "facts"), "dir");

  await writeJsonBundle(outDir, [
    {
      path: "facts/secret.md",
      content: "escaped",
    },
  ]);

  await assert.rejects(
    importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir }),
    /symlink/i,
  );
  await assertPathMissing(outsidePath);
});
