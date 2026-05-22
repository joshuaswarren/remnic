import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBinaryLifecyclePipeline } from "./pipeline.js";
import { writeManifest } from "./manifest.js";
import type { BinaryLifecycleConfig } from "./types.js";
import type { BinaryStorageBackend } from "./backend.js";

const baseConfig: BinaryLifecycleConfig = {
  enabled: true,
  gracePeriodDays: 0,
  maxBinarySizeBytes: 1024 * 1024,
  scanPatterns: ["*.png"],
  backend: { type: "none" },
};

test("binary lifecycle pipeline is a no-op when disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-disabled-"));
  let uploaded = false;
  try {
    await writeFile(path.join(memoryDir, "image.png"), "bytes", "utf8");
    const backend = {
      type: "test",
      upload: async () => {
        uploaded = true;
        return "remote";
      },
      exists: async () => false,
      delete: async () => {},
    } satisfies BinaryStorageBackend;

    const result = await runBinaryLifecyclePipeline(
      memoryDir,
      { ...baseConfig, enabled: false },
      backend,
      noopLogger,
    );

    assert.deepEqual(result, {
      scanned: 0,
      mirrored: 0,
      redirected: 0,
      cleaned: 0,
      errors: [],
      dryRun: false,
    });
    assert.equal(uploaded, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle remirrors changed tracked binaries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-remirror-"));
  const uploaded: string[] = [];
  try {
    await writeFile(path.join(memoryDir, "image.png"), "new-content", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "image.png",
          contentHash: sha256("old-content"),
          sizeBytes: "old-content".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "mirrored",
        },
      ],
    });
    const backend = {
      type: "test",
      upload: async (_localPath: string, remotePath: string) => {
        uploaded.push(remotePath);
        return `remote/${remotePath}`;
      },
      exists: async () => false,
      delete: async () => {},
    } satisfies BinaryStorageBackend;

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, backend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ originalPath: string; contentHash: string; mirroredPath: string }> };

    assert.equal(result.mirrored, 1);
    assert.deepEqual(uploaded, ["image.png"]);
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0]?.contentHash, sha256("new-content"));
    assert.equal(manifest.assets[0]?.mirroredPath, "remote/image.png");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle blocks cleanup when local hash no longer matches manifest", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-clean-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "changed", "utf8");
    await writeFile(path.join(memoryDir, "note.md"), "![img](image.png)", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("original"),
          sizeBytes: "original".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);

    assert.equal(result.cleaned, 0);
    assert.match(result.errors.join("\n"), /local content hash does not match manifest/);
    assert.equal(await readFile(path.join(memoryDir, "image.png"), "utf8"), "changed");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noUploadBackend = {
  type: "test",
  upload: async () => {
    throw new Error("upload should not run");
  },
  exists: async () => false,
  delete: async () => {},
} satisfies BinaryStorageBackend;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
