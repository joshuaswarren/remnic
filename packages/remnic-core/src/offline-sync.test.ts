import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyOfflineSyncChangeset,
  applyOfflineSyncSnapshot,
  buildOfflineSyncChangeset,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotForPaths,
  readOfflineSyncFileContentChunk,
} from "./offline-sync.js";
import { isEncryptedFile } from "./secure-store/secure-fs.js";
import { StorageManager } from "./storage.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function write(root: string, relPath: string, content: string | Buffer): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function readUtf8(root: string, relPath: string): Promise<string> {
  return readFile(path.join(root, relPath), "utf-8");
}

test("offline snapshot captures source-of-truth files and excludes private/internal paths", async () => {
  const root = await tempDir("remnic-offline-snapshot");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "facts/fact-hashes.txt", "user-authored memory file");
    await write(root, "transcripts/session.jsonl", "turn");
    await write(root, "assets/blob.bin", Buffer.from([0, 1, 2, 255]));
    await write(root, ".secure-store/header.json", "secret");
    await write(root, ".offline-sync/state/local.json", "state");
    await write(root, "state/fact-hashes.txt", "derived");
    await write(root, "state/fact-hashes.ready", "v1");
    await write(root, "state/lcm.sqlite", "live db");
    await write(root, "state/lcm.sqlite-shm", "live shm");
    await write(root, "state/lcm.sqlite-wal", "live wal");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["assets/blob.bin", "facts/a.md", "facts/fact-hashes.txt", "transcripts/session.jsonl"],
    );
    const binary = snapshot.files.find((file) => file.path === "assets/blob.bin");
    assert.equal(Buffer.from(binary?.contentBase64 ?? "", "base64")[3], 255);

    const withoutTranscripts = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
      includeTranscripts: false,
    });
    assert.deepEqual(
      withoutTranscripts.files.map((file) => file.path),
      ["assets/blob.bin", "facts/a.md", "facts/fact-hashes.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync excludes live LCM sqlite artifacts without deleting existing local copies", async () => {
  const root = await tempDir("remnic-offline-lcm-sqlite");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "state/lcm.sqlite", "live db");
    await write(root, "state/lcm.sqlite-shm", "live shm");
    await write(root, "state/lcm.sqlite-wal", "live wal");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(snapshot.files.map((file) => file.path), ["facts/a.md"]);
    await assert.rejects(
      () =>
        buildOfflineSyncSnapshotForPaths({
          root,
          sourceId: "remote",
          paths: ["state/lcm.sqlite"],
          includeContent: true,
        }),
      /offline sync snapshot path is excluded: state\/lcm\.sqlite/,
    );

    const oldDb = Buffer.from("old live db");
    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot,
      baseFiles: [{
        path: "state/lcm.sqlite",
        sha256: createHash("sha256").update(oldDb).digest("hex"),
        bytes: oldDb.byteLength,
        mtimeMs: 0,
      }],
    });

    assert.equal(pull.deleted, 0);
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "live db");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync reads bounded file content chunks with metadata", async () => {
  const root = await tempDir("remnic-offline-file-content");
  try {
    await write(root, "state/memory-lifecycle-ledger.jsonl", "alpha\nbeta\ngamma\n");

    const chunk = await readOfflineSyncFileContentChunk({
      root,
      path: "state/memory-lifecycle-ledger.jsonl",
      offset: 6,
      length: 5,
    });

    assert.equal(chunk.path, "state/memory-lifecycle-ledger.jsonl");
    assert.equal(chunk.offset, 6);
    assert.equal(chunk.chunkBytes, 5);
    assert.equal(chunk.content.toString("utf-8"), "beta\n");
    assert.equal(chunk.bytes, Buffer.byteLength("alpha\nbeta\ngamma\n"));

    await assert.rejects(
      () =>
        readOfflineSyncFileContentChunk({
          root,
          path: "state/lcm.sqlite",
        }),
      /offline sync file content path is excluded: state\/lcm\.sqlite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset pushes local edits when the remote is still at the shared base", async () => {
  const remote = await tempDir("remnic-offline-remote");
  const local = await tempDir("remnic-offline-local");
  try {
    await write(remote, "facts/base.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const pull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/base.md", "base plus local");
    await write(local, "facts/local-only.md", "new local fact");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: pull.nextBaseFiles,
    });

    assert.equal(changeset.changes.length, 2);
    const push = await applyOfflineSyncChangeset({
      root: remote,
      changeset,
    });

    assert.equal(push.appliedUpserts, 2);
    assert.equal(push.conflicts.length, 0);
    assert.equal(await readUtf8(remote, "facts/base.md"), "base plus local");
    assert.equal(await readUtf8(remote, "facts/local-only.md"), "new local fact");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline changeset only carries content for changed local files", async () => {
  const local = await tempDir("remnic-offline-changeset-content");
  try {
    await write(local, "facts/unchanged.md", "same");
    await write(local, "facts/changed.md", "before");
    const base = await buildOfflineSyncSnapshot({
      root: local,
      sourceId: "remote",
      includeContent: false,
    });

    await write(local, "facts/changed.md", "after");
    await write(local, "facts/empty.md", "");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: base.files,
    });

    assert.deepEqual(
      changeset.changes.map((change) => change.path),
      ["facts/changed.md", "facts/empty.md"],
    );
    const empty = changeset.changes.find((change) => change.path === "facts/empty.md");
    assert.equal(empty?.type, "upsert");
    if (empty?.type === "upsert") {
      assert.equal(empty.file.contentBase64, "");
    }
    assert.equal(JSON.stringify(changeset).includes("same"), false);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull accepts metadata-only snapshots when files are unchanged", async () => {
  const remote = await tempDir("remnic-offline-metadata-remote");
  const local = await tempDir("remnic-offline-metadata-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });
    const metadataOnly = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: false,
    });

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: metadataOnly,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.conflicts.length, 0);
    assert.equal(secondPull.upserted, 0);
    assert.equal(secondPull.skipped, 1);
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull applies snapshots with content only for remote-changed files", async () => {
  const remote = await tempDir("remnic-offline-partial-remote");
  const local = await tempDir("remnic-offline-partial-local");
  try {
    await write(remote, "facts/shared.md", "base");
    await write(remote, "facts/stable.md", "unchanged");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(remote, "facts/shared.md", "remote edit");
    const metadataOnly = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: false,
    });
    const changedContent = await buildOfflineSyncSnapshotForPaths({
      root: remote,
      sourceId: "remote",
      paths: ["facts/shared.md"],
      includeContent: true,
    });
    const contentByPath = new Map(
      changedContent.files.map((file) => [file.path, file.contentBase64]),
    );
    const hydrated = {
      ...metadataOnly,
      files: metadataOnly.files.map((file) => {
        const contentBase64 = contentByPath.get(file.path);
        return contentBase64 === undefined ? file : { ...file, contentBase64 };
      }),
    };

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: hydrated,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.upserted, 1);
    assert.equal(secondPull.conflicts.length, 0);
    assert.equal(await readUtf8(local, "facts/shared.md"), "remote edit");
    assert.equal(await readUtf8(local, "facts/stable.md"), "unchanged");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull preserves local edits when both sides changed since the base", async () => {
  const remote = await tempDir("remnic-offline-conflict-remote");
  const local = await tempDir("remnic-offline-conflict-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/shared.md", "local edit");
    await write(remote, "facts/shared.md", "remote edit");
    const remoteSnapshot = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: remoteSnapshot,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.conflicts.length, 1);
    assert.equal(secondPull.conflicts[0]?.reason, "both_modified");
    assert.equal(await readUtf8(local, "facts/shared.md"), "local edit");
    const conflictPath = secondPull.conflicts[0]?.conflictPath;
    assert.ok(conflictPath);
    assert.equal(await readUtf8(local, conflictPath), "remote edit");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline push preserves remote edits when both sides changed since the base", async () => {
  const remote = await tempDir("remnic-offline-push-conflict-remote");
  const local = await tempDir("remnic-offline-push-conflict-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/shared.md", "local edit");
    await write(remote, "facts/shared.md", "remote edit");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: firstPull.nextBaseFiles,
    });

    const push = await applyOfflineSyncChangeset({
      root: remote,
      changeset,
    });

    assert.equal(push.appliedUpserts, 0);
    assert.equal(push.conflicts.length, 1);
    assert.equal(push.conflicts[0]?.reason, "remote_changed_for_local_update");
    assert.equal(await readUtf8(remote, "facts/shared.md"), "remote edit");
    const conflictPath = push.conflicts[0]?.conflictPath;
    assert.ok(conflictPath);
    assert.equal(await readUtf8(remote, conflictPath), "local edit");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull applies remote deletion when the local file is unchanged", async () => {
  const remote = await tempDir("remnic-offline-delete-remote");
  const local = await tempDir("remnic-offline-delete-local");
  try {
    await write(remote, "facts/deleted.md", "soon gone");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await rm(path.join(remote, "facts/deleted.md"), { force: true });
    const remoteSnapshot = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: remoteSnapshot,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.deleted, 1);
    await assert.rejects(
      () => readFile(path.join(local, "facts/deleted.md")),
      /ENOENT/,
    );
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline changeset does not delete transcript baselines when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-transcript-mode");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "transcripts/session.jsonl", "turn");
    const base = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    await rm(path.join(root, "transcripts"), { recursive: true, force: true });
    const changeset = await buildOfflineSyncChangeset({
      root,
      sourceId: "laptop",
      baseFiles: base.files,
      includeTranscripts: false,
    });

    assert.deepEqual(changeset.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset rejects transcript changes when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-transcript-invalid");
  try {
    await write(root, "facts/a.md", "alpha");
    const transcript = Buffer.from("turn");
    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: false,
            changes: [{
              type: "upsert",
              path: "transcripts/session.jsonl",
              file: {
                path: "transcripts/session.jsonl",
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                bytes: transcript.byteLength,
                mtimeMs: 0,
                contentBase64: transcript.toString("base64"),
              },
            }],
          },
        }),
      /offline sync changeset includeTranscripts is false but contains transcript path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot rejects transcript records when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-snapshot-transcript-invalid");
  try {
    const transcript = Buffer.from("turn");
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            includeTranscripts: false,
            files: [{
              path: "transcripts/session.jsonl",
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              bytes: transcript.byteLength,
              mtimeMs: 0,
              contentBase64: transcript.toString("base64"),
            }],
          },
        }),
      /offline sync snapshot includeTranscripts is false but contains transcript path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline payloads require explicit includeTranscripts booleans", async () => {
  const root = await tempDir("remnic-offline-include-transcripts-invalid");
  try {
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            files: [],
          },
        }),
      /includeTranscripts must be a boolean/,
    );

    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: "false",
            changes: [],
          },
        }),
      /includeTranscripts must be a boolean/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline payloads reject excluded internal paths", async () => {
  const root = await tempDir("remnic-offline-internal-path-invalid");
  try {
    const header = Buffer.from("secret");
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            includeTranscripts: true,
            files: [{
              path: ".secure-store/header.json",
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              bytes: header.byteLength,
              mtimeMs: 0,
              contentBase64: header.toString("base64"),
            }],
          },
        }),
      /offline sync snapshot contains excluded path: \.secure-store\/header\.json/,
    );

    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: true,
            changes: [{
              type: "upsert",
              path: ".secure-store/header.json",
              file: {
                path: ".secure-store/header.json",
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                bytes: header.byteLength,
                mtimeMs: 0,
                contentBase64: header.toString("base64"),
              },
            }],
          },
        }),
      /offline sync changeset contains excluded path: \.secure-store\/header\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync applies and snapshots through secure storage hooks", async () => {
  const root = await tempDir("remnic-offline-secure-store");
  const source = await tempDir("remnic-offline-secure-source");
  try {
    await write(source, "facts/secure.md", "secret fact");
    const changeset = await buildOfflineSyncChangeset({
      root: source,
      sourceId: "laptop",
    });
    const storage = new StorageManager(root);
    storage.setSecureStoreKey(Buffer.alloc(32, 7));
    storage.setSecureStoreRequired(true);

    const apply = await applyOfflineSyncChangeset({
      root,
      changeset,
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
      deleteFile: async ({ filePath }) => storage.deleteOfflineSyncFile(filePath),
    });

    assert.equal(apply.appliedUpserts, 1);
    const raw = await readFile(path.join(root, "facts", "secure.md"));
    assert.equal(isEncryptedFile(raw), true);
    assert.equal(
      (await storage.readOfflineSyncFile(path.join(root, "facts", "secure.md"))).toString("utf8"),
      "secret fact",
    );

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    });
    assert.equal(
      Buffer.from(snapshot.files[0]?.contentBase64 ?? "", "base64").toString("utf8"),
      "secret fact",
    );
    assert.equal(snapshot.files[0]?.bytes, Buffer.byteLength("secret fact"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("offline storage writes invalidate fact hash readiness for rebuild", async () => {
  const root = await tempDir("remnic-offline-hash-index-local");
  const source = await tempDir("remnic-offline-hash-index-source");
  try {
    const localStorage = new StorageManager(root);
    await localStorage.writeMemory("fact", "alpha fact");
    assert.equal(await localStorage.hasFactContentHash("alpha fact"), true);
    assert.equal(await localStorage.hasFactContentHash("beta fact"), false);

    const sourceStorage = new StorageManager(source);
    await sourceStorage.writeMemory("fact", "beta fact");
    const sourceChangeset = await buildOfflineSyncChangeset({
      root: source,
      sourceId: "remote",
    });

    assert.equal(
      sourceChangeset.changes.some((change) => change.path.startsWith("state/fact-hashes")),
      false,
    );

    const factChangeset = {
      ...sourceChangeset,
      changes: sourceChangeset.changes.filter((change) => change.path.startsWith("facts/")),
    };
    const apply = await applyOfflineSyncChangeset({
      root,
      changeset: factChangeset,
      readFile: async ({ filePath }) => localStorage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => localStorage.writeOfflineSyncFile(filePath, content),
      deleteFile: async ({ filePath }) => localStorage.deleteOfflineSyncFile(filePath),
    });

    assert.equal(apply.conflicts.length, 0);
    assert.equal(await localStorage.hasFactContentHash("beta fact"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("offline changeset validation reports client input errors with an offline sync prefix", async () => {
  const root = await tempDir("remnic-offline-invalid-changeset");
  try {
    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: true,
            changes: [{ type: "delete", path: "../escape", baseSha256: "nope" }],
          },
        }),
      /offline sync changeset invalid:/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
