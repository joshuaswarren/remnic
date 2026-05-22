/**
 * Binary file lifecycle management tests (#367).
 *
 * Covers: scanner, backend, manifest, pipeline stages (mirror, redirect, clean),
 * dry-run, empty directory, max-size gating, and manifest round-trip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";

import {
  scanForBinaries,
  matchesPatterns,
  FilesystemBackend,
  NoneBackend,
  createBackend,
  readManifest,
  writeManifest,
  emptyManifest,
  manifestPath,
  runBinaryLifecyclePipeline,
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
} from "../packages/remnic-core/src/binary-lifecycle/index.ts";

import type {
  BinaryLifecycleConfig,
  BinaryLifecycleManifest,
} from "../packages/remnic-core/src/binary-lifecycle/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPrefix(): string {
  return path.join(os.tmpdir(), "remnic-binary-lifecycle-test-");
}

function makeConfig(overrides?: Partial<BinaryLifecycleConfig>): BinaryLifecycleConfig {
  return {
    enabled: true,
    gracePeriodDays: DEFAULT_GRACE_PERIOD_DAYS,
    maxBinarySizeBytes: DEFAULT_MAX_BINARY_SIZE_BYTES,
    scanPatterns: DEFAULT_SCAN_PATTERNS,
    backend: { type: "none" },
    ...overrides,
  };
}

const noopLog = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  error: (_msg: string) => {},
};

// ---------------------------------------------------------------------------
// matchesPatterns
// ---------------------------------------------------------------------------

test("matchesPatterns matches *.png and *.pdf, ignores .md", () => {
  const patterns = ["*.png", "*.pdf"];
  assert.equal(matchesPatterns("screenshot.png", patterns), true);
  assert.equal(matchesPatterns("DOCUMENT.PDF", patterns), true);
  assert.equal(matchesPatterns("notes.md", patterns), false);
  assert.equal(matchesPatterns("image.jpg", patterns), false);
});

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

test("scanner finds PNG/PDF in temp dir, ignores .md files", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "screenshot.png"), Buffer.alloc(100));
    await writeFile(path.join(dir, "document.pdf"), Buffer.alloc(200));
    await writeFile(path.join(dir, "notes.md"), "# Hello");
    await writeFile(path.join(dir, "data.json"), '{"a":1}');

    const config = makeConfig();
    const manifest = emptyManifest();
    const found = await scanForBinaries(dir, config, manifest);

    assert.equal(found.length, 2);
    const names = found.map((p) => path.basename(p)).sort();
    assert.deepEqual(names, ["document.pdf", "screenshot.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanner skips files already tracked in manifest", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "screenshot.png"), Buffer.alloc(100));

    const config = makeConfig();
    const manifest: BinaryLifecycleManifest = {
      version: 1,
      assets: [
        {
          originalPath: "screenshot.png",
          mirroredPath: "screenshot.png",
          contentHash: "abc123",
          sizeBytes: 100,
          mimeType: "image/png",
          mirroredAt: new Date().toISOString(),
          status: "mirrored",
        },
      ],
    };
    const found = await scanForBinaries(dir, config, manifest);
    assert.equal(found.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanner skips files over maxBinarySizeBytes", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    // 100 bytes is under the 50-byte limit
    await writeFile(path.join(dir, "small.png"), Buffer.alloc(40));
    await writeFile(path.join(dir, "big.png"), Buffer.alloc(100));

    const config = makeConfig({ maxBinarySizeBytes: 50 });
    const found = await scanForBinaries(dir, config, emptyManifest());
    assert.equal(found.length, 1);
    assert.equal(path.basename(found[0]), "small.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Filesystem backend
// ---------------------------------------------------------------------------

test("FilesystemBackend copies file correctly, exists() returns true", async () => {
  const srcDir = await mkdtemp(tmpPrefix());
  const destDir = await mkdtemp(tmpPrefix());
  try {
    const srcFile = path.join(srcDir, "test.png");
    await writeFile(srcFile, Buffer.from("PNG_DATA"));

    const backend = new FilesystemBackend(destDir);
    const result = await backend.upload(srcFile, "subdir/test.png");

    assert.ok(result.includes("test.png"));
    assert.equal(await backend.exists("subdir/test.png"), true);
    assert.equal(await backend.exists("nonexistent.png"), false);

    // Verify content was copied correctly.
    const copied = await readFile(path.join(destDir, "subdir", "test.png"), "utf-8");
    assert.equal(copied, "PNG_DATA");
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  }
});

test("FilesystemBackend.delete removes the file", async () => {
  const destDir = await mkdtemp(tmpPrefix());
  try {
    const filePath = path.join(destDir, "to-delete.png");
    await writeFile(filePath, "data");

    const backend = new FilesystemBackend(destDir);
    assert.equal(await backend.exists("to-delete.png"), true);
    await backend.delete("to-delete.png");
    assert.equal(await backend.exists("to-delete.png"), false);
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});

test("FilesystemBackend.delete is idempotent (ENOENT ignored)", async () => {
  const destDir = await mkdtemp(tmpPrefix());
  try {
    const backend = new FilesystemBackend(destDir);
    // Should not throw.
    await backend.delete("nonexistent.png");
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
});

test("FilesystemBackend rejects remote paths outside its base directory", async () => {
  const srcDir = await mkdtemp(tmpPrefix());
  const destDir = await mkdtemp(tmpPrefix());
  const outsideDir = await mkdtemp(tmpPrefix());
  try {
    const srcFile = path.join(srcDir, "test.png");
    const outsideFile = path.join(outsideDir, "escape.png");
    await writeFile(srcFile, Buffer.from("PNG_DATA"));
    await writeFile(outsideFile, Buffer.from("KEEP"));

    const backend = new FilesystemBackend(destDir);
    const escapePath = path.relative(destDir, outsideFile);
    await assert.rejects(
      () => backend.upload(srcFile, escapePath),
      /escapes basePath/,
    );
    await assert.rejects(
      () => backend.exists(escapePath),
      /escapes basePath/,
    );
    await assert.rejects(
      () => backend.delete(escapePath),
      /escapes basePath/,
    );
    assert.equal(await readFile(outsideFile, "utf-8"), "KEEP");
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// None backend
// ---------------------------------------------------------------------------

test("NoneBackend is a no-op", async () => {
  const backend = new NoneBackend();
  const result = await backend.upload("/tmp/any.png", "remote/any.png");
  assert.equal(result, "remote/any.png");
  assert.equal(await backend.exists("remote/any.png"), false);
  // delete should not throw
  await backend.delete("remote/any.png");
});

// ---------------------------------------------------------------------------
// createBackend factory
// ---------------------------------------------------------------------------

test("createBackend returns correct backend instances", () => {
  const none = createBackend({ type: "none" });
  assert.equal(none.type, "none");

  const fs = createBackend({ type: "filesystem", basePath: "/tmp/test" });
  assert.equal(fs.type, "filesystem");

  assert.throws(() => createBackend({ type: "s3" }), /not yet implemented/);
});

test("createBackend rejects filesystem without basePath", () => {
  assert.throws(
    () => createBackend({ type: "filesystem" }),
    /basePath is required/,
  );
});

// ---------------------------------------------------------------------------
// Manifest round-trip
// ---------------------------------------------------------------------------

test("manifest round-trip: write then read preserves all fields", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    const original: BinaryLifecycleManifest = {
      version: 1,
      lastScanAt: "2026-01-15T10:00:00.000Z",
      assets: [
        {
          originalPath: "images/photo.jpg",
          mirroredPath: "images/photo.jpg",
          contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          sizeBytes: 12345,
          mimeType: "image/jpeg",
          mirroredAt: "2026-01-15T10:00:00.000Z",
          redirectedAt: "2026-01-15T11:00:00.000Z",
          cleanedAt: "2026-01-22T10:00:00.000Z",
          status: "cleaned",
        },
      ],
    };

    await writeManifest(dir, original);
    const loaded = await readManifest(dir);

    assert.deepEqual(loaded, original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readManifest returns empty manifest for missing file", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, { version: 1, assets: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readManifest returns empty manifest for invalid JSON", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    const mPath = manifestPath(dir);
    await mkdir(path.dirname(mPath), { recursive: true });
    await writeFile(mPath, "not json at all");
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, { version: 1, assets: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readManifest returns empty manifest for JSON null", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    const mPath = manifestPath(dir);
    await mkdir(path.dirname(mPath), { recursive: true });
    await writeFile(mPath, "null");
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest, { version: 1, assets: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pipeline: mirror stage
// ---------------------------------------------------------------------------

test("mirror stage creates manifest entry with status 'mirrored'", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "photo.png"), Buffer.alloc(64));

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.scanned, 1);
    assert.equal(result.mirrored, 1);
    assert.equal(result.dryRun, false);

    // Verify manifest on disk.
    const manifest = await readManifest(dir);
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0].status, "mirrored");
    assert.equal(manifest.assets[0].originalPath, "photo.png");
    assert.ok(manifest.assets[0].contentHash.length > 0);
    // mirroredPath should reflect actual backend location, not the original relative path.
    assert.ok(
      manifest.assets[0].mirroredPath.includes(backendDir),
      "mirroredPath should contain the backend base path",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pipeline: redirect stage
// ---------------------------------------------------------------------------

test("redirect stage replaces ![img](./screenshot.png) with redirect path", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    // Create a binary file and a markdown file referencing it.
    await writeFile(path.join(dir, "screenshot.png"), Buffer.alloc(64));
    await writeFile(
      path.join(dir, "notes.md"),
      "Here is an image: ![img](./screenshot.png) and text.",
    );

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0, // so it tries to clean immediately
    });
    const backend = createBackend(config.backend);

    // First run: mirrors + redirects.
    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.mirrored, 1);
    assert.equal(result.redirected, 1);

    // Verify the markdown was updated.
    const mdContent = await readFile(path.join(dir, "notes.md"), "utf-8");
    assert.ok(!mdContent.includes("./screenshot.png"), "original ref should be replaced");
    assert.ok(mdContent.includes("screenshot.png"), "redirect path should be present");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pipeline: clean stage
// ---------------------------------------------------------------------------

test("clean stage deletes local file after grace period", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "old.png"), Buffer.alloc(64));
    // A markdown reference is needed so the redirect stage transitions the
    // asset to "redirected" — cleanup only processes redirected assets.
    await writeFile(
      path.join(dir, "ref.md"),
      "![img](./old.png)",
    );

    // Set grace period to 0 so everything is immediately eligible.
    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0,
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.mirrored, 1);
    assert.equal(result.redirected, 1);
    // With gracePeriodDays=0, the file should be cleaned in the same run.
    assert.equal(result.cleaned, 1);

    // Local file should be gone.
    assert.equal(fs.existsSync(path.join(dir, "old.png")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

test("clean stage does NOT delete mirrored-only assets (no redirect)", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    // Binary file with NO markdown reference — stays "mirrored", never "redirected".
    await writeFile(path.join(dir, "unreferenced.png"), Buffer.alloc(64));

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0, // Past grace, but cleanup should still skip it.
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.mirrored, 1);
    assert.equal(result.redirected, 0);
    // Mirrored-only assets must not be cleaned — markdown refs still point local.
    assert.equal(result.cleaned, 0);

    // Local file must still exist.
    assert.equal(fs.existsSync(path.join(dir, "unreferenced.png")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

test("clean stage does NOT delete before grace period", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "recent.png"), Buffer.alloc(64));

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 30, // Far future — should not clean.
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.mirrored, 1);
    assert.equal(result.cleaned, 0);

    // Local file should still exist.
    assert.equal(fs.existsSync(path.join(dir, "recent.png")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

test("pipeline rejects invalid gracePeriodDays before cleanup can delete files", async () => {
  for (const gracePeriodDays of [-1, NaN]) {
    const dir = await mkdtemp(tmpPrefix());
    try {
      await writeFile(path.join(dir, "recent.png"), Buffer.alloc(64));
      await writeManifest(dir, {
        version: 1,
        assets: [
          {
            originalPath: "recent.png",
            mirroredPath: "remote/recent.png",
            contentHash: "abc123",
            sizeBytes: 64,
            mimeType: "image/png",
            mirroredAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
            redirectedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
            status: "redirected",
          },
        ],
      });

      await assert.rejects(
        () =>
          runBinaryLifecyclePipeline(
            dir,
            makeConfig({ gracePeriodDays }),
            new NoneBackend(),
            noopLog,
          ),
        /gracePeriodDays/,
      );

      assert.equal(fs.existsSync(path.join(dir, "recent.png")), true);
      const manifest = await readManifest(dir);
      assert.equal(manifest.assets[0]?.status, "redirected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

test("dry-run mode reports actions but makes no changes", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "test.png"), Buffer.alloc(64));

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0,
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog, { dryRun: true },
    );

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 1);
    assert.equal(result.mirrored, 1);
    // Dry-run: no actual file operations.
    // The manifest should NOT have been written to disk.
    const manifest = await readManifest(dir);
    assert.equal(manifest.assets.length, 0, "manifest should not be persisted in dry-run");

    // Backend should not have the file.
    const backendFile = path.join(backendDir, "test.png");
    assert.equal(fs.existsSync(backendFile), false, "backend should not receive file in dry-run");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

test("dry-run mode preserves existing manifest lifecycle state", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    await writeFile(path.join(dir, "image.png"), Buffer.alloc(64));
    await writeFile(path.join(dir, "old.png"), Buffer.alloc(64));
    await writeFile(path.join(dir, "notes.md"), "![img](./image.png)");

    const originalManifest: BinaryLifecycleManifest = {
      version: 1,
      lastScanAt: "2026-01-01T00:00:00.000Z",
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: "image-hash",
          sizeBytes: 64,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "mirrored",
        },
        {
          originalPath: "old.png",
          mirroredPath: "remote/old.png",
          contentHash: "old-hash",
          sizeBytes: 64,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          redirectedAt: "2026-01-01T01:00:00.000Z",
          status: "redirected",
        },
      ],
    };
    await writeManifest(dir, originalManifest);

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0,
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog, { dryRun: true },
    );

    assert.equal(result.dryRun, true);
    assert.equal(result.mirrored, 0);
    assert.equal(result.redirected, 1);
    assert.equal(result.cleaned, 1);
    assert.deepEqual(await readManifest(dir), originalManifest);
    assert.equal(await readFile(path.join(dir, "notes.md"), "utf-8"), "![img](./image.png)");
    assert.equal(fs.existsSync(path.join(dir, "image.png")), true);
    assert.equal(fs.existsSync(path.join(dir, "old.png")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Empty directory
// ---------------------------------------------------------------------------

test("empty directory: pipeline returns zeros", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    const config = makeConfig();
    const backend = new NoneBackend();
    const result = await runBinaryLifecyclePipeline(
      dir, config, backend, noopLog,
    );

    assert.equal(result.scanned, 0);
    assert.equal(result.mirrored, 0);
    assert.equal(result.redirected, 0);
    assert.equal(result.cleaned, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scanner with subdirectories
// ---------------------------------------------------------------------------

test("scanner finds binaries in nested subdirectories", async () => {
  const dir = await mkdtemp(tmpPrefix());
  try {
    await mkdir(path.join(dir, "sub", "deep"), { recursive: true });
    await writeFile(path.join(dir, "root.png"), Buffer.alloc(10));
    await writeFile(path.join(dir, "sub", "nested.jpg"), Buffer.alloc(10));
    await writeFile(path.join(dir, "sub", "deep", "deep.gif"), Buffer.alloc(10));

    const config = makeConfig();
    const found = await scanForBinaries(dir, config, emptyManifest());
    assert.equal(found.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1: redirect status blocked when markdown rewrite fails
// ---------------------------------------------------------------------------

test("redirect stage sets error status when a markdown write fails", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    // Create a binary file and a markdown file referencing it.
    await writeFile(path.join(dir, "fail.png"), Buffer.alloc(64));
    await writeFile(
      path.join(dir, "notes.md"),
      "![img](./fail.png)",
    );

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
    });
    const backend = createBackend(config.backend);

    // Run mirror first to get the asset into "mirrored" status.
    const result1 = await runBinaryLifecyclePipeline(dir, config, backend, noopLog);
    assert.equal(result1.mirrored, 1);
    assert.equal(result1.redirected, 1);

    // Now set up a scenario where rewrite fails: reset status to mirrored
    // and make the markdown file read-only so writeFile fails.
    const manifest = await readManifest(dir);
    manifest.assets[0].status = "mirrored";
    delete (manifest.assets[0] as Record<string, unknown>).redirectedAt;
    await writeManifest(dir, manifest);

    // Restore original content and make the file unwritable.
    await writeFile(path.join(dir, "notes.md"), "![img](./fail.png)");
    fs.chmodSync(path.join(dir, "notes.md"), 0o444);

    const errorLog: string[] = [];
    const log = {
      info: (_msg: string) => {},
      warn: (_msg: string) => {},
      error: (msg: string) => { errorLog.push(msg); },
    };

    const result2 = await runBinaryLifecyclePipeline(dir, config, backend, log);

    // Redirect should have failed — asset should NOT be "redirected".
    assert.equal(result2.redirected, 0);
    assert.ok(result2.errors.length > 0, "should report rewrite errors");

    // Verify the asset status is "error", not "redirected".
    const manifest2 = await readManifest(dir);
    assert.equal(manifest2.assets[0].status, "error");

    // Restore permissions for cleanup.
    fs.chmodSync(path.join(dir, "notes.md"), 0o644);
  } finally {
    // Ensure cleanup can work even if chmod failed above.
    try { fs.chmodSync(path.join(dir, "notes.md"), 0o644); } catch { /* ignore */ }
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P2: redirect matches asset paths relative to each markdown file
// ---------------------------------------------------------------------------

test("redirect stage resolves asset paths relative to markdown file directory", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    // Create a subdirectory with both a binary and a markdown file.
    // The asset.originalPath will be "sub/image.png" (memory-root relative),
    // but sub/note.md references it as "./image.png" (file-relative).
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "image.png"), Buffer.alloc(64));
    await writeFile(
      path.join(dir, "sub", "note.md"),
      "Look: ![pic](./image.png) here.",
    );

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
      gracePeriodDays: 0,
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(dir, config, backend, noopLog);

    assert.equal(result.mirrored, 1);
    // The redirect should succeed because the pipeline now resolves
    // "sub/image.png" relative to sub/note.md's directory as "./image.png".
    assert.equal(result.redirected, 1);

    // Verify the markdown was updated.
    const mdContent = await readFile(path.join(dir, "sub", "note.md"), "utf-8");
    assert.ok(!mdContent.includes("./image.png"), "original file-relative ref should be replaced");
    assert.ok(mdContent.includes(backendDir), "redirect path should contain backend path");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});

test("redirect stage handles markdown in parent dir referencing asset in subdir", async () => {
  const dir = await mkdtemp(tmpPrefix());
  const backendDir = await mkdtemp(tmpPrefix());
  try {
    // Binary in a subdirectory, markdown at root level.
    // asset.originalPath = "images/photo.png"
    // root.md references it as "./images/photo.png" (file-relative from root).
    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images", "photo.png"), Buffer.alloc(64));
    await writeFile(
      path.join(dir, "root.md"),
      "See: ![photo](./images/photo.png) end.",
    );

    const config = makeConfig({
      backend: { type: "filesystem", basePath: backendDir },
    });
    const backend = createBackend(config.backend);

    const result = await runBinaryLifecyclePipeline(dir, config, backend, noopLog);

    assert.equal(result.mirrored, 1);
    assert.equal(result.redirected, 1);

    const mdContent = await readFile(path.join(dir, "root.md"), "utf-8");
    assert.ok(!mdContent.includes("./images/photo.png"), "original ref should be replaced");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true });
  }
});
