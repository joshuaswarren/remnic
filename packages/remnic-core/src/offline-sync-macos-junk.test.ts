import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OFFLINE_SYNC_CHANGESET_FORMAT,
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  applyOfflineSyncFileContentChunk,
  applyOfflineSyncSnapshot,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotForPaths,
  buildOfflineSyncSnapshotFromBase,
  normalizeOfflineSyncChangeset,
  normalizeOfflineSyncSnapshot,
} from "./offline-sync.js";

async function write(root: string, relPath: string, content: string | Buffer): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

test("offline sync omits macOS replication junk on snapshot, push, and pull", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-macos-junk-"));
  const dest = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-macos-junk-dest-"));
  try {
    await write(root, "namespaces/lab/entities/project-real.md", "real entity");
    await write(root, "namespaces/lab/entities/._sidecar.md", Buffer.from([0, 5, 22]));
    await write(root, "namespaces/lab/.DS_Store", "finder");
    await write(root, "entities/._root.md", Buffer.from([0, 5, 22]));
    await write(root, ".DS_Store", "finder-root");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["namespaces/lab/entities/project-real.md"]
    );

    const pullSide = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "local",
      includeContent: false,
      excludeNodeLocalState: false,
    });
    assert.deepEqual(
      pullSide.files.map((file) => file.path),
      ["namespaces/lab/entities/project-real.md"]
    );

    await assert.rejects(
      () =>
        buildOfflineSyncSnapshotForPaths({
          root,
          sourceId: "remote",
          paths: ["namespaces/lab/entities/._sidecar.md"],
          includeContent: true,
        }),
      /offline sync snapshot path is excluded/
    );
    await assert.rejects(
      () =>
        applyOfflineSyncFileContentChunk({
          root: dest,
          sourceId: "remote",
          path: "namespaces/lab/.DS_Store",
          sha256: createHash("sha256").update("finder").digest("hex"),
          bytes: 6,
          mtimeMs: 1,
          content: Buffer.from("finder"),
        }),
      /offline sync file content path is excluded/
    );

    const real = snapshot.files[0];
    const incoming = {
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1 as const,
      createdAt: snapshot.createdAt,
      sourceId: "remote",
      includeTranscripts: true,
      files: [
        real,
        {
          ...real,
          path: "namespaces/lab/entities/._sidecar.md",
          contentBase64: Buffer.from("sidecar").toString("base64"),
          sha256: createHash("sha256").update("sidecar").digest("hex"),
          bytes: Buffer.byteLength("sidecar"),
        },
        {
          ...real,
          path: "namespaces/other/.DS_Store",
          contentBase64: Buffer.from("finder").toString("base64"),
          sha256: createHash("sha256").update("finder").digest("hex"),
          bytes: Buffer.byteLength("finder"),
        },
      ],
      deletions: [
        { path: "facts/removed.md", mtimeMs: 2 },
        { path: "entities/._root.md", mtimeMs: 1 },
      ],
    };
    const normalized = normalizeOfflineSyncSnapshot(incoming);
    assert.deepEqual(
      normalized.files.map((file) => file.path),
      ["namespaces/lab/entities/project-real.md"]
    );
    assert.deepEqual(normalized.deletions, [{ path: "facts/removed.md", mtimeMs: 2 }]);

    const applied = await applyOfflineSyncSnapshot({ root: dest, snapshot: incoming });
    assert.equal(applied.upserted, 1);
    assert.equal(await readFile(path.join(dest, "namespaces/lab/entities/project-real.md"), "utf8"), "real entity");
    await assert.rejects(() => readFile(path.join(dest, "namespaces/lab/entities/._sidecar.md")), { code: "ENOENT" });
    await assert.rejects(() => readFile(path.join(dest, "namespaces/other/.DS_Store")), { code: "ENOENT" });

    const changeset = normalizeOfflineSyncChangeset({
      format: OFFLINE_SYNC_CHANGESET_FORMAT,
      schemaVersion: 1,
      createdAt: snapshot.createdAt,
      sourceId: "remote",
      includeTranscripts: true,
      changes: [
        { type: "upsert", path: real.path, file: real },
        {
          type: "upsert",
          path: "namespaces/lab/.DS_Store",
          file: {
            ...real,
            path: "namespaces/lab/.DS_Store",
          },
        },
      ],
    });
    assert.deepEqual(
      changeset.changes.map((change) => change.path),
      ["namespaces/lab/entities/project-real.md"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});
