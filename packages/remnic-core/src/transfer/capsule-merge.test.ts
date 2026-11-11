/**
 * capsule-merge gunzip bounds — Finding C3 companion to capsule-import.test.ts.
 *
 * mergeCapsule reads the same gzip archive shape as importCapsule; the shared
 * helper must refuse a real bomb with a clear oversize error.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { makeTempDir } from "../testing/tmp-dir.js";
import { CAPSULE_IMPORT_MAX_GUNZIP_BYTES } from "./capsule-gunzip.js";
import { mergeCapsule } from "./capsule-merge.js";

test("mergeCapsule refuses a small gzip that expands past the output bound", async () => {
  const dir = await makeTempDir("cap-merge-gunzip-bomb-");
  const bombPayload = Buffer.alloc(CAPSULE_IMPORT_MAX_GUNZIP_BYTES + 1, 0x41);
  const archivePath = path.join(dir, "bomb.capsule.json.gz");
  await writeFile(archivePath, gzipSync(bombPayload));

  const root = await makeTempDir("cap-merge-gunzip-bomb-root-");
  await assert.rejects(
    () =>
      mergeCapsule({
        sourceArchive: archivePath,
        targetRoot: root,
        conflictMode: "skip-conflicts",
      }),
    /mergeCapsule: archive decompressed size exceeds limit of \d+ bytes/,
  );
});
