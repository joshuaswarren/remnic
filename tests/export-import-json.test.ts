import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJsonBundle } from "../src/transfer/export-json.js";
import { importJsonBundle } from "../src/transfer/import-json.js";
import {
  prepareSafeArchiveRoot,
  resolveSafeArchiveTarget,
  sha256String,
  writeSafeArchiveTarget,
} from "../src/transfer/fs-utils.js";
import { writeFixtureMemoryDir, writeSensitiveTransferFixtureEntries } from "./transfer-fixtures.js";

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
      ...sha256String(record.content),
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

test("json export rejects non-UTF8 files instead of emitting unverifiable v1 checksums", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await mkdir(path.join(memDir, "binary-lifecycle"), { recursive: true });
  await writeFile(path.join(memDir, "binary-lifecycle", "payload.bin"), Buffer.from([0xff, 0xfe, 0xfd]));

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await assert.rejects(
    exportJsonBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" }),
    /requires UTF-8 text files/,
  );
});

test("json export preserves UTF-8 BOM bytes in manifest-validated records", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  const profileBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x6c, 0x65, 0x0a]);
  await writeFile(path.join(memDir, "profile.md"), profileBytes);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await exportJsonBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const res = await importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir });

  assert.equal(res.written, 1);
  assert.deepEqual(await readFile(path.join(targetDir, "profile.md")), profileBytes);
});

test("json import rejects tampered records before writing files", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  await writeJsonBundle(outDir, [
    {
      path: "profile.md",
      content: "trusted profile\n",
    },
  ]);

  const bundlePath = path.join(outDir, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf-8")) as {
    records: Array<{ path: string; content: string }>;
  };
  bundle.records[0].content = "tampered profile\n";
  await writeFile(bundlePath, JSON.stringify(bundle), "utf-8");

  await assert.rejects(
    importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir }),
    /checksum mismatch|byte count mismatch/,
  );
  await assertPathMissing(targetPath);
});

test("json import rejects duplicate record paths before writing files", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  await writeJsonBundle(outDir, [
    {
      path: "profile.md",
      content: "profile\n",
    },
  ]);

  const bundlePath = path.join(outDir, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf-8")) as {
    records: Array<{ path: string; content: string }>;
  };
  bundle.records.push({ path: "profile.md", content: "profile\n" });
  await writeFile(bundlePath, JSON.stringify(bundle), "utf-8");

  await assert.rejects(
    importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir }),
    /duplicate record path/,
  );
  await assertPathMissing(targetPath);
});

test("json export excludes secure store, capsules, VCS, and dependencies", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  await writeSensitiveTransferFixtureEntries(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await exportJsonBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const bundle = JSON.parse(await readFile(path.join(outDir, "bundle.json"), "utf-8")) as {
    records: Array<{ path: string; content: string }>;
    manifest: { files: Array<{ path: string }> };
  };
  const paths = bundle.records.map((record) => record.path);
  assert.equal(paths.some((entry) => entry.startsWith(".secure-store/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".capsules/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".git/")), false);
  assert.equal(paths.some((entry) => entry.startsWith("node_modules/")), false);
  assert.ok(paths.includes("facts/2026-02-11/fact-1.md"));
  assert.deepEqual(bundle.manifest.files.map((file) => file.path), paths);
});

test("json export rejects output directory equal to memory directory", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  await assert.rejects(
    exportJsonBundle({ memoryDir: memDir, outDir: memDir, pluginVersion: "2.2.3" }),
    /output path must not equal the memory directory/,
  );
});

test("json import rejects invalid conflict policy without overwriting existing files", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  await writeJsonBundle(outDir, [
    {
      path: "profile.md",
      content: "incoming profile\n",
    },
  ]);
  await writeFile(targetPath, "original profile\n", "utf-8");

  await assert.rejects(
    importJsonBundle({
      targetMemoryDir: targetDir,
      fromDir: outDir,
      conflict: "replace" as any,
    }),
    /invalid conflict policy/i,
  );
  assert.equal(await readFile(targetPath, "utf-8"), "original profile\n");
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

test("safe archive writes revalidate target symlinks after earlier path resolution", async (t) => {
  if (process.platform === "win32") {
    t.skip("file symlink setup is platform-specific");
    return;
  }

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));
  const outsidePath = path.join(outsideDir, "outside.md");
  await writeFile(outsidePath, "external original\n", "utf-8");

  const root = await prepareSafeArchiveRoot(
    targetDir,
    "importJsonBundle",
    "targetMemoryDir",
  );
  await resolveSafeArchiveTarget(root, "profile.md");
  await symlink(outsidePath, path.join(targetDir, "profile.md"), "file");

  await assert.rejects(
    writeSafeArchiveTarget(root, "profile.md", "incoming profile\n"),
    /targets a symlink/i,
  );
  assert.equal(await readFile(outsidePath, "utf-8"), "external original\n");
});

test("safe archive write failures remove temporary import files", async () => {
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  await mkdir(path.join(targetDir, "profile.md"));

  const root = await prepareSafeArchiveRoot(
    targetDir,
    "importJsonBundle",
    "targetMemoryDir",
  );

  await assert.rejects(
    writeSafeArchiveTarget(root, "profile.md", "incoming profile\n"),
  );
  const leftovers = (await readdir(targetDir)).filter((entry) =>
    entry.startsWith(".remnic-import-") && entry.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);
});
