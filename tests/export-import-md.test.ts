import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importMarkdownBundle } from "../src/transfer/import-md.js";
import { sha256Bytes, sha256String, writeJsonFile } from "../src/transfer/fs-utils.js";

async function writeManifest(
  fromDir: string,
  records: Array<{ path: string; content: string | Uint8Array }>,
): Promise<void> {
  await writeJsonFile(path.join(fromDir, "manifest.json"), {
    format: "openclaw-engram-export",
    schemaVersion: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    pluginVersion: "test",
    includesTranscripts: false,
    files: records.map((record) => ({
      path: record.path,
      ...(typeof record.content === "string"
        ? sha256String(record.content)
        : sha256Bytes(record.content)),
    })),
  });
}

test("markdown import rejects invalid conflict policy without overwriting existing files", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  await writeFile(path.join(fromDir, "profile.md"), "incoming profile\n", "utf-8");
  await writeManifest(fromDir, [{ path: "profile.md", content: "incoming profile\n" }]);
  await writeFile(targetPath, "original profile\n", "utf-8");

  await assert.rejects(
    importMarkdownBundle({
      targetMemoryDir: targetDir,
      fromDir,
      conflict: "replace" as any,
    }),
    /invalid conflict policy/i,
  );
  assert.equal(await readFile(targetPath, "utf-8"), "original profile\n");
});

test("markdown import rejects target subdirectory symlinks outside the memory root", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));

  try {
    await mkdir(path.join(fromDir, "facts"), { recursive: true });
    await writeFile(path.join(fromDir, "facts", "a.md"), "incoming fact\n", "utf-8");
    await writeManifest(fromDir, [{ path: "facts/a.md", content: "incoming fact\n" }]);
    await symlink(outsideDir, path.join(targetDir, "facts"), "dir");

    await assert.rejects(
      importMarkdownBundle({
        targetMemoryDir: targetDir,
        fromDir,
        conflict: "overwrite",
      }),
      /escapes target root via symlink|targets a symlink/,
    );

    await assert.rejects(
      readFile(path.join(outsideDir, "a.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("markdown import rejects symlinked target memory roots", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const parentDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-parent-"));
  const targetLink = path.join(parentDir, "target-link");

  try {
    await writeFile(path.join(fromDir, "profile.md"), "incoming profile\n", "utf-8");
    await writeManifest(fromDir, [{ path: "profile.md", content: "incoming profile\n" }]);
    await symlink(targetDir, targetLink, "dir");

    await assert.rejects(
      importMarkdownBundle({
        targetMemoryDir: targetLink,
        fromDir,
        conflict: "overwrite",
      }),
      /targetMemoryDir' must not be a symlink/,
    );

    await assert.rejects(
      readFile(path.join(targetDir, "profile.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(parentDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("markdown import rejects tampered files before writing", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  try {
    await writeFile(path.join(fromDir, "profile.md"), "tampered profile\n", "utf-8");
    await writeManifest(fromDir, [{ path: "profile.md", content: "trusted profile\n" }]);

    await assert.rejects(
      importMarkdownBundle({ targetMemoryDir: targetDir, fromDir }),
      /checksum mismatch|byte count mismatch/,
    );
    await assert.rejects(readFile(targetPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("markdown import rejects files missing from the manifest before writing", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  try {
    await writeFile(path.join(fromDir, "profile.md"), "incoming profile\n", "utf-8");
    await writeManifest(fromDir, []);

    await assert.rejects(
      importMarkdownBundle({ targetMemoryDir: targetDir, fromDir }),
      /record missing from manifest/,
    );
    await assert.rejects(readFile(targetPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("markdown import validates and writes raw file bytes", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const sourceBytes = Buffer.from([0xff, 0xfe, 0xfd]);

  try {
    await mkdir(path.join(fromDir, "binary-lifecycle"), { recursive: true });
    await writeFile(path.join(fromDir, "binary-lifecycle", "payload.bin"), sourceBytes);
    await writeManifest(fromDir, [{ path: "binary-lifecycle/payload.bin", content: sourceBytes }]);

    const result = await importMarkdownBundle({ targetMemoryDir: targetDir, fromDir });
    assert.equal(result.written, 1);
    assert.deepEqual(
      await readFile(path.join(targetDir, "binary-lifecycle", "payload.bin")),
      sourceBytes,
    );
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("markdown dedupe compares raw bytes for non-text content", async () => {
  const fromDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const incomingBytes = Buffer.from([0xfe]);
  const existingBytes = Buffer.from([0xff]);
  const targetPath = path.join(targetDir, "binary-lifecycle", "payload.bin");

  try {
    await mkdir(path.join(fromDir, "binary-lifecycle"), { recursive: true });
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(path.join(fromDir, "binary-lifecycle", "payload.bin"), incomingBytes);
    await writeFile(targetPath, existingBytes);
    await writeManifest(fromDir, [{ path: "binary-lifecycle/payload.bin", content: incomingBytes }]);

    const result = await importMarkdownBundle({
      targetMemoryDir: targetDir,
      fromDir,
      conflict: "dedupe",
    });
    assert.equal(result.written, 1);
    assert.deepEqual(await readFile(targetPath), incomingBytes);
  } finally {
    await rm(fromDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
