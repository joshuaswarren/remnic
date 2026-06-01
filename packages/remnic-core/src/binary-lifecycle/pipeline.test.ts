import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBinaryLifecyclePipeline } from "./pipeline.js";
import { manifestPath, writeManifest } from "./manifest.js";
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

test("binary lifecycle blocks manifest cleanup paths outside memoryDir", async () => {
  const parentDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-escape-parent-"));
  const memoryDir = path.join(parentDir, "memory");
  const victimPath = path.join(parentDir, "victim.png");
  try {
    await mkdir(memoryDir);
    await writeFile(victimPath, "victim", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "../victim.png",
          mirroredPath: "remote/victim.png",
          contentHash: sha256("victim"),
          sizeBytes: "victim".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ originalPath: string; status: string }> };

    assert.equal(result.cleaned, 0);
    assert.match(result.errors.join("\n"), /manifest path is outside memoryDir/);
    assert.equal(await readFile(victimPath, "utf8"), "victim");
    assert.equal(manifest.assets[0]?.originalPath, "../victim.png");
    assert.equal(manifest.assets[0]?.status, "error");
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});

test("binary lifecycle allows hidden asset names that remain inside memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-hidden-clean-"));
  try {
    await writeFile(path.join(memoryDir, "..hidden.png"), "hidden", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "..hidden.png",
          mirroredPath: "remote/..hidden.png",
          contentHash: sha256("hidden"),
          sizeBytes: "hidden".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.cleaned, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(manifest.assets[0]?.status, "cleaned");
    assert.equal(typeof manifest.assets[0]?.cleanedAt, "string");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle dry-run does not mark missing redirected assets cleaned", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-dry-clean-"));
  try {
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "missing.png",
          mirroredPath: "remote/missing.png",
          contentHash: sha256("missing"),
          sizeBytes: "missing".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(
      memoryDir,
      baseConfig,
      nestedRemoteBackend,
      noopLogger,
      { dryRun: true },
    );
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.cleaned, 0);
    assert.equal(manifest.assets[0]?.status, "redirected");
    assert.equal(manifest.assets[0]?.cleanedAt, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle blocks cleanup when manifest mirroredAt is invalid", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-invalid-timestamp-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "not-a-date",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const firstResult = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    let manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string }> };

    assert.equal(firstResult.cleaned, 0);
    assert.match(firstResult.errors.join("\n"), /manifest mirroredAt is invalid/);
    assert.equal(await readFile(path.join(memoryDir, "image.png"), "utf8"), "image");
    assert.equal(manifest.assets[0]?.status, "error");

    const secondResult = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string }> };

    assert.equal(secondResult.redirected, 0);
    assert.equal(secondResult.cleaned, 0);
    assert.match(secondResult.errors.join("\n"), /manifest mirroredAt is invalid/);
    assert.equal(manifest.assets[0]?.status, "error");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle blocks cleanup when mirrored copy is missing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-missing-remote-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(
      memoryDir,
      baseConfig,
      missingRemoteBackend,
      noopLogger,
    );
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.cleaned, 0);
    assert.match(result.errors.join("\n"), /mirrored copy is missing/);
    assert.equal(await readFile(path.join(memoryDir, "image.png"), "utf8"), "image");
    assert.equal(manifest.assets[0]?.status, "redirected");
    assert.equal(manifest.assets[0]?.cleanedAt, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle blocks cleanup when mirrored copy verification fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-remote-error-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "redirected",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(
      memoryDir,
      baseConfig,
      failingRemoteBackend,
      noopLogger,
    );
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.cleaned, 0);
    assert.match(result.errors.join("\n"), /failed to verify mirrored copy/);
    assert.equal(await readFile(path.join(memoryDir, "image.png"), "utf8"), "image");
    assert.equal(manifest.assets[0]?.status, "redirected");
    assert.equal(manifest.assets[0]?.cleanedAt, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle retries partial redirect failures before cleanup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-partial-redirect-"));
  const imagePath = path.join(memoryDir, "image.png");
  const firstNote = path.join(memoryDir, "first.md");
  const secondNote = path.join(memoryDir, "second.md");
  try {
    await writeFile(imagePath, "image", "utf8");
    await writeFile(firstNote, "![img](image.png)", "utf8");
    await writeFile(secondNote, "![img](image.png)", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "mirrored",
        },
      ],
    });

    const firstResult = await runBinaryLifecyclePipeline(
      memoryDir,
      baseConfig,
      nestedRemoteBackend,
      noopLogger,
      {
        writeMarkdownFile: async (file, data) => {
          if (file === secondNote) {
            throw new Error("injected write failure");
          }
          await writeFile(file, data, "utf8");
        },
      },
    );
    let manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string }> };

    assert.equal(firstResult.cleaned, 0);
    assert.match(firstResult.errors.join("\n"), /redirect write failed/);
    assert.equal(await readFile(imagePath, "utf8"), "image");
    assert.equal(await readFile(firstNote, "utf8"), "![img](remote/image.png)");
    assert.equal(await readFile(secondNote, "utf8"), "![img](image.png)");
    assert.equal(manifest.assets[0]?.status, "error");

    const secondResult = await runBinaryLifecyclePipeline(memoryDir, baseConfig, nestedRemoteBackend, noopLogger);
    manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string }> };

    assert.equal(secondResult.errors.length, 0);
    assert.equal(secondResult.redirected, 1);
    assert.equal(secondResult.cleaned, 1);
    assert.equal(await readFile(firstNote, "utf8"), "![img](remote/image.png)");
    assert.equal(await readFile(secondNote, "utf8"), "![img](remote/image.png)");
    assert.equal(manifest.assets[0]?.status, "cleaned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle rewrites nested asset references before cleanup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-nested-redirect-"));
  const assetDir = path.join(memoryDir, "assets");
  const noteDir = path.join(memoryDir, "notes");
  const imagePath = path.join(assetDir, "photo.png");
  const rootNote = path.join(memoryDir, "note.md");
  const nestedNote = path.join(noteDir, "nested.md");
  try {
    await mkdir(assetDir);
    await mkdir(noteDir);
    await writeFile(imagePath, "image", "utf8");
    await writeFile(rootNote, "![img](assets/photo.png)", "utf8");
    await writeFile(
      nestedNote,
      ["![relative](../assets/photo.png)", "![root](/assets/photo.png)"].join("\n"),
      "utf8",
    );

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, nestedRemoteBackend, noopLogger);

    assert.equal(result.errors.length, 0);
    assert.equal(result.redirected, 1);
    assert.equal(result.cleaned, 1);
    assert.equal(await readFile(rootNote, "utf8"), "![img](remote/assets/photo.png)");
    assert.equal(
      await readFile(nestedNote, "utf8"),
      ["![relative](remote/assets/photo.png)", "![root](remote/assets/photo.png)"].join("\n"),
    );
    await assert.rejects(() => readFile(imagePath, "utf8"), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle rewrites dot-slash hidden asset references before cleanup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-hidden-redirect-"));
  try {
    await writeFile(path.join(memoryDir, ".photo.png"), "hidden", "utf8");
    await writeFile(path.join(memoryDir, "note.md"), "![img](./.photo.png)", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: ".photo.png",
          mirroredPath: "remote/.photo.png",
          contentHash: sha256("hidden"),
          sizeBytes: "hidden".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "mirrored",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, nestedRemoteBackend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string }> };

    assert.equal(result.errors.length, 0);
    assert.equal(result.redirected, 1);
    assert.equal(result.cleaned, 1);
    assert.equal(await readFile(path.join(memoryDir, "note.md"), "utf8"), "![img](remote/.photo.png)");
    assert.equal(manifest.assets[0]?.status, "cleaned");
    await assert.rejects(() => readFile(path.join(memoryDir, ".photo.png"), "utf8"), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle does not rewrite ambiguous nested bare links for root assets", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-ambiguous-link-"));
  const subDir = path.join(memoryDir, "sub");
  const nestedNote = path.join(subDir, "note.md");
  try {
    await mkdir(subDir);
    await writeFile(path.join(memoryDir, "image.png"), "root", "utf8");
    await writeFile(path.join(subDir, "image.png"), "nested", "utf8");
    await writeFile(nestedNote, "![img](image.png)", "utf8");

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, nestedRemoteBackend, noopLogger);

    assert.equal(result.errors.length, 0);
    assert.equal(result.mirrored, 2);
    assert.equal(result.redirected, 1);
    assert.equal(await readFile(nestedNote, "utf8"), "![img](remote/sub/image.png)");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle resumes errored assets with no remaining local references", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-resume-error-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeFile(path.join(memoryDir, "note.md"), "![img](remote/image.png)", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T00:00:00.000Z",
          status: "error",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.errors.length, 0);
    assert.equal(result.redirected, 1);
    assert.equal(result.cleaned, 1);
    assert.equal(manifest.assets[0]?.status, "cleaned");
    assert.equal(typeof manifest.assets[0]?.cleanedAt, "string");
    await assert.rejects(() => readFile(path.join(memoryDir, "image.png"), "utf8"), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle resumes redirects after verification read failures", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-verify-read-error-"));
  const notePath = path.join(memoryDir, "note.md");
  let noteReads = 0;
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeFile(notePath, "![img](image.png)", "utf8");

    const firstResult = await runBinaryLifecyclePipeline(
      memoryDir,
      baseConfig,
      nestedRemoteBackend,
      noopLogger,
      {
        readMarkdownFile: async (file) => {
          if (file === notePath && noteReads++ > 0) {
            throw new Error("injected verification read failure");
          }
          return readFile(file, "utf8");
        },
      },
    );
    let manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; redirectedAt?: string }> };

    assert.equal(firstResult.cleaned, 0);
    assert.match(firstResult.errors.join("\n"), /injected verification read failure/);
    assert.equal(await readFile(notePath, "utf8"), "![img](remote/image.png)");
    assert.equal(manifest.assets[0]?.status, "error");
    assert.equal(typeof manifest.assets[0]?.redirectedAt, "string");

    const secondResult = await runBinaryLifecyclePipeline(memoryDir, baseConfig, nestedRemoteBackend, noopLogger);
    manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(secondResult.errors.length, 0);
    assert.equal(secondResult.redirected, 1);
    assert.equal(secondResult.cleaned, 1);
    assert.equal(manifest.assets[0]?.status, "cleaned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle keeps unreferenced errored assets mirrored-only", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-error-unreferenced-"));
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: sha256("image"),
          sizeBytes: "image".length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "error",
        },
      ],
    });

    const result = await runBinaryLifecyclePipeline(memoryDir, baseConfig, noUploadBackend, noopLogger);
    const manifest = JSON.parse(
      await readFile(path.join(memoryDir, ".binary-lifecycle", "manifest.json"), "utf8"),
    ) as { assets: Array<{ status: string; cleanedAt?: string }> };

    assert.equal(result.errors.length, 0);
    assert.equal(result.redirected, 0);
    assert.equal(result.cleaned, 0);
    assert.equal(manifest.assets[0]?.status, "mirrored");
    assert.equal(manifest.assets[0]?.cleanedAt, undefined);
    assert.equal(await readFile(path.join(memoryDir, "image.png"), "utf8"), "image");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("binary lifecycle fails closed without overwriting an invalid manifest", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-binary-invalid-manifest-"));
  let uploaded = false;
  try {
    await writeFile(path.join(memoryDir, "image.png"), "image", "utf8");
    const mPath = manifestPath(memoryDir);
    await mkdir(path.dirname(mPath), { recursive: true });
    await writeFile(mPath, '{"version":1,"assets":[', "utf8");
    const backend = {
      type: "test",
      upload: async () => {
        uploaded = true;
        return "remote/image.png";
      },
      exists: async () => false,
      delete: async () => {},
    } satisfies BinaryStorageBackend;

    await assert.rejects(
      () => runBinaryLifecyclePipeline(memoryDir, baseConfig, backend, noopLogger),
      /Invalid binary lifecycle manifest JSON/,
    );
    assert.equal(uploaded, false);
    assert.equal(await readFile(mPath, "utf8"), '{"version":1,"assets":[');
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
  exists: async () => true,
  delete: async () => {},
} satisfies BinaryStorageBackend;

const missingRemoteBackend = {
  type: "test",
  upload: async () => {
    throw new Error("upload should not run");
  },
  exists: async () => false,
  delete: async () => {},
} satisfies BinaryStorageBackend;

const failingRemoteBackend = {
  type: "test",
  upload: async () => {
    throw new Error("upload should not run");
  },
  exists: async () => {
    throw new Error("remote unavailable");
  },
  delete: async () => {},
} satisfies BinaryStorageBackend;

const nestedRemoteBackend = {
  type: "test",
  upload: async (_localPath: string, remotePath: string) => `remote/${remotePath}`,
  exists: async () => true,
  delete: async () => {},
} satisfies BinaryStorageBackend;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
