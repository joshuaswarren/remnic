/**
 * Unit coverage for offline-sync-upload-staging.ts (issue #3164): the real
 * on-disk staging layout under a temp archive root — content-keyed spools,
 * chunk offset contiguity, crash debris reclamation, symlink defenses, and
 * the mid-flight reset a second writer performs at offset 0. These functions
 * are also the write path for remote-authoritative runtime state (#3165).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { prepareSafeArchiveRoot, sha256Bytes, type SafeArchiveRoot } from "./transfer/fs-utils.js";
import { SYNC_INTERNAL_DIR } from "./offline-sync-file-io.js";
import { applyOfflineSyncFileContentChunk } from "./offline-sync.js";
import {
  cleanupOfflineUpload,
  digestOfflineUploadStagingContent,
  hashText,
  pruneOfflineUploadStaging,
  writeOfflineUploadChunk,
  writeSafeFileFromUpload,
  type OfflineUploadStaging,
} from "./offline-sync-upload-staging.js";

const SHA_A = "a".repeat(64);

let rootDirCounter = 0;

async function newRoot(): Promise<{ root: SafeArchiveRoot; abs: string }> {
  const abs = await mkdtemp(path.join(tmpdir(), `upload-staging-${process.pid}-${rootDirCounter++}-`));
  const root = await prepareSafeArchiveRoot(abs, "test-root", "root");
  return { root, abs };
}

function uploadsDir(abs: string): string {
  return path.join(abs, SYNC_INTERNAL_DIR, "uploads");
}

/** Drive an upload the way applyOfflineSyncFileContentChunk does, with a fixed chunk size. */
async function stagedUpload(options: {
  root: SafeArchiveRoot;
  abs: string;
  relPath?: string;
  content: Buffer;
  chunkSize: number;
  sourceId?: string;
}): Promise<string> {
  const relPath = options.relPath ?? "namespaces/alpha/facts/fact-1.md";
  const sourceId = options.sourceId ?? "source-1";
  const sha256 = sha256Bytes(options.content).sha256;
  let upload: OfflineUploadStaging | null = null;
  try {
    if (options.content.length === 0) {
      upload = await writeOfflineUploadChunk({
        root: options.root,
        sourceId,
        relPath,
        sha256,
        bytes: 0,
        offset: 0,
        content: Buffer.alloc(0),
      });
    }
    for (let offset = 0; offset < options.content.length; offset += options.chunkSize) {
      const end = Math.min(offset + options.chunkSize, options.content.length);
      upload = await writeOfflineUploadChunk({
        root: options.root,
        sourceId,
        relPath,
        sha256,
        bytes: options.content.length,
        offset,
        content: options.content.subarray(offset, end),
      });
    }
    if (upload === null) throw new Error("unreachable: the empty-content path still writes chunk 0");
    const digest = await digestOfflineUploadStagingContent({ root: options.root, upload });
    assert.equal(digest.sha256, sha256);
    assert.equal(digest.bytes, options.content.length);
    await writeSafeFileFromUpload(options.root, relPath, upload, undefined, undefined, undefined);
    return path.join(options.abs, relPath);
  } finally {
    if (upload) await cleanupOfflineUpload(upload);
  }
}

test("multi-chunk upload writes exact bytes and reclaims its staging", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const content = Buffer.from("abcdefghij", "utf8");
  const target = await stagedUpload({ root, abs, content, chunkSize: 4 });
  assert.equal(await readFile(target, "utf8"), "abcdefghij");
  assert.deepEqual(await readdir(uploadsDir(abs)).catch(() => []), [], "staging reclaimed after finalize");
});

test("empty upload (bytes 0) still creates an empty target file", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const target = await stagedUpload({ root, abs, content: Buffer.alloc(0), chunkSize: 4 });
  const stat = await lstat(target);
  assert.equal(stat.size, 0, "empty upload creates a zero-byte target");
});

test("chunk above offset 0 without the initial chunk fails loudly", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  await assert.rejects(
    writeOfflineUploadChunk({
      root,
      sourceId: "source-1",
      relPath: "namespaces/alpha/facts/fact-1.md",
      sha256: SHA_A,
      bytes: 100,
      offset: 4,
      content: Buffer.from("abcd"),
    }),
    /missing initial chunk/,
  );
});

test("digest refuses a gapped chunk sequence instead of skipping bytes", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const upload = await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 100, offset: 0,
    content: Buffer.from("aaaa"),
  });
  await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 100, offset: 9,
    content: Buffer.from("bbbb"),
  });
  await assert.rejects(
    digestOfflineUploadStagingContent({ root, upload }),
    /offset mismatch .* expected 4, got 9/,
  );
  await cleanupOfflineUpload(upload);
});

test("a second writer's offset-0 reset converges identical content and corrupts nothing", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const declared = sha256Bytes(Buffer.from("12345678")).sha256;
  const shared = { root, sourceId: "source-1", relPath, sha256: declared, bytes: 8 };
  const first = await writeOfflineUploadChunk({ ...shared, offset: 0, content: Buffer.from("1234") });
  await writeOfflineUploadChunk({ ...shared, offset: 0, content: Buffer.from("1234") });
  await writeOfflineUploadChunk({ ...shared, offset: 4, content: Buffer.from("5678") });
  const digest = await digestOfflineUploadStagingContent({ root, upload: first });
  assert.deepEqual(digest, { sha256: declared, bytes: 8 });
  await writeSafeFileFromUpload(root, relPath, first, undefined, undefined, undefined);
  assert.equal(await readFile(path.join(abs, relPath), "utf8"), "12345678");
  await cleanupOfflineUpload(first);
});

test("a reset carrying different bytes fails the real consumer's checksum gate", async (t) => {
  const { abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const declared = sha256Bytes(Buffer.from("12345678")).sha256;
  const shared = {
    root: abs,
    sourceId: "source-1",
    path: relPath,
    sha256: declared,
    bytes: 8,
    mtimeMs: 1_700_000_000_000,
  };
  await applyOfflineSyncFileContentChunk({ ...shared, offset: 0, content: Buffer.from("1234") });
  await applyOfflineSyncFileContentChunk({ ...shared, offset: 0, content: Buffer.from("9999") });
  await assert.rejects(
    applyOfflineSyncFileContentChunk({ ...shared, offset: 4, content: Buffer.from("5678") }),
    /checksum mismatch/,
  );
  assert.deepEqual(
    await readdir(uploadsDir(abs)).catch(() => []),
    [],
    "the consumer reclaimed the failed spool",
  );
  assert.equal(fs.existsSync(path.join(abs, relPath)), false, "target never written from a bad spool");
});

test("crash debris: abandoned staging is reclaimed only after the 24h age, by pattern", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const stagingKey = hashText(["source-1", relPath, SHA_A, "8"].join("\0"));
  const stage = path.join(uploadsDir(abs), `${stagingKey}.part`);
  await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 8, offset: 0, content: Buffer.from("1234"),
  });
  assert.equal((await readdir(uploadsDir(abs))).length, 1);

  await pruneOfflineUploadStaging(root);
  assert.equal((await readdir(uploadsDir(abs))).length, 1, "fresh abandoned staging is kept");

  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(stage, stale, stale);
  await pruneOfflineUploadStaging(root);
  assert.equal((await readdir(uploadsDir(abs))).length, 0, "aged-out staging is reclaimed");

  await writeFile(path.join(uploadsDir(abs), "not-a-part"), "keep me");
  await writeFile(path.join(uploadsDir(abs), `${"z".repeat(64)}.part`), "keep me too");
  await utimes(path.join(uploadsDir(abs), "not-a-part"), stale, stale);
  await utimes(path.join(uploadsDir(abs), `${"z".repeat(64)}.part`), stale, stale);
  await pruneOfflineUploadStaging(root);
  assert.deepEqual((await readdir(uploadsDir(abs))).sort(), [
    "not-a-part",
    `${"z".repeat(64)}.part`,
  ]);
});

test("symlinked chunk path is rejected before write", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const stagingKey = hashText(["source-1", relPath, SHA_A, "8"].join("\0"));
  const stage = path.join(uploadsDir(abs), `${stagingKey}.part`);
  await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 8, offset: 0, content: Buffer.from("1234"),
  });
  const victim = path.join(abs, "victim.txt");
  await writeFile(victim, "do not touch");
  await symlink(victim, path.join(stage, `${String(4).padStart(20, "0")}.part`));
  await assert.rejects(
    writeOfflineUploadChunk({
      root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 8, offset: 4, content: Buffer.from("5678"),
    }),
    /symlink/,
  );
  assert.equal(await readFile(victim, "utf8"), "do not touch", "symlink target untouched");
});

test("symlinked final target is rejected and no tmp file is left behind", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const upload = await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 8, offset: 0, content: Buffer.from("1234"),
  });
  const realTarget = path.join(abs, "elsewhere.md");
  await writeFile(realTarget, "existing file");
  await mkdir(path.dirname(path.join(abs, relPath)), { recursive: true });
  await symlink(realTarget, path.join(abs, relPath));
  await assert.rejects(
    writeSafeFileFromUpload(root, relPath, upload, undefined, undefined, undefined),
    /symlink/,
  );
  assert.equal(await readFile(realTarget, "utf8"), "existing file", "symlink target not overwritten");
  const leftovers = (await readdir(path.dirname(path.join(abs, relPath))))
    .filter((name) => name.startsWith(".remnic-sync."));
  assert.deepEqual(leftovers, [], "atomic-write tmp cleaned up");
  await cleanupOfflineUpload(upload);
});

test("writeFileChunks hook receives every chunk in order without a local tmp", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const relPath = "namespaces/alpha/facts/fact-1.md";
  const upload = await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 12, offset: 0, content: Buffer.from("1234"),
  });
  await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 12, offset: 4, content: Buffer.from("5678"),
  });
  await writeOfflineUploadChunk({
    root, sourceId: "source-1", relPath, sha256: SHA_A, bytes: 12, offset: 8, content: Buffer.from("90ab"),
  });
  const streamed: Buffer[] = [];
  const mtimeMs = 1_700_000_000_000;
  await writeSafeFileFromUpload(root, relPath, upload, undefined, async (target) => {
    assert.equal(target.path, relPath);
    for await (const chunk of target.chunks) streamed.push(Buffer.from(chunk));
  }, mtimeMs);
  assert.equal(Buffer.concat(streamed).toString("utf8"), "1234567890ab");
  assert.equal(
    fs.existsSync(path.join(abs, relPath)),
    false,
    "hook path does not also write a local file",
  );
  await cleanupOfflineUpload(upload);
});

test("concurrent staging keeps identical content at different paths isolated", async (t) => {
  const { root, abs } = await newRoot();
  t.after(() => rm(abs, { recursive: true, force: true }));
  const content = Buffer.from("12345678");
  const shared = { root, sourceId: "source-1", ...sha256Bytes(content) };
  const firstPath = "namespaces/alpha/facts/one.md";
  const secondPath = "namespaces/alpha/facts/two.md";
  const first = await writeOfflineUploadChunk({
    ...shared, relPath: firstPath, offset: 0, content: content.subarray(0, 4),
  });
  const second = await writeOfflineUploadChunk({
    ...shared, relPath: secondPath, offset: 0, content: content.subarray(0, 4),
  });
  await writeOfflineUploadChunk({
    ...shared, relPath: firstPath, offset: 4, content: content.subarray(4),
  });
  assert.deepEqual(await digestOfflineUploadStagingContent({ root, upload: first }), sha256Bytes(content));
  await writeSafeFileFromUpload(root, firstPath, first);
  await cleanupOfflineUpload(first);
  await writeOfflineUploadChunk({
    ...shared, relPath: secondPath, offset: 4, content: content.subarray(4),
  });
  assert.deepEqual(await digestOfflineUploadStagingContent({ root, upload: second }), sha256Bytes(content));
  await writeSafeFileFromUpload(root, secondPath, second);
  await cleanupOfflineUpload(second);
  assert.deepEqual(await readFile(path.join(abs, firstPath)), content);
  assert.deepEqual(await readFile(path.join(abs, secondPath)), content);
});
