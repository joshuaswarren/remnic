/**
 * capsule-import bounds — Finding C3 (gzip bomb / unbounded gunzip).
 *
 * importCapsule() previously called gunzipSync with no maxOutputLength, so a
 * small highly-compressible archive could expand into multi-gigabyte buffers.
 * These tests pin the refusal of a real gzip-bomb shape and keep a normal
 * capsule import green.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { makeTempDir } from "../testing/tmp-dir.js";
import { exportCapsule } from "./capsule-export.js";
import {
  CAPSULE_IMPORT_MAX_GUNZIP_BYTES,
  importCapsule,
} from "./capsule-import.js";

async function writeFact(dir: string, id: string, body: string): Promise<void> {
  await mkdir(path.join(dir, "facts"), { recursive: true });
  await writeFile(
    path.join(dir, "facts", `${id}.md`),
    `---\nid: ${id}\n---\n${body}\n`,
  );
}

test("importCapsule refuses a small gzip that expands past the output bound", async () => {
  const dir = await makeTempDir("cap-gunzip-bomb-");
  // Highly compressible payload one byte over the decompressed cap. gzip of
  // 64 MiB of identical bytes stays ~65 KiB — a classic bomb shape.
  const bombPayload = Buffer.alloc(CAPSULE_IMPORT_MAX_GUNZIP_BYTES + 1, 0x41);
  const archivePath = path.join(dir, "bomb.capsule.json.gz");
  await writeFile(archivePath, gzipSync(bombPayload));

  const root = await makeTempDir("cap-gunzip-bomb-root-");
  await assert.rejects(
    () =>
      importCapsule({
        archivePath,
        root,
        mode: "skip",
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw an Error");
      assert.match(
        err.message,
        /importCapsule: archive decompressed size exceeds limit of \d+ bytes/,
        `expected clear oversize error, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("importCapsule still imports a normal capsule archive", async () => {
  const srcDir = await makeTempDir("cap-gunzip-ok-src-");
  const dstDir = await makeTempDir("cap-gunzip-ok-dst-");
  const outDir = await makeTempDir("cap-gunzip-ok-out-");

  await writeFact(srcDir, "fact-ok", "Normal capsule fact.");
  const exported = await exportCapsule({
    name: "gunzip-ok-capsule",
    root: srcDir,
    outDir,
    pluginVersion: "0.0.0-test",
    now: 1_700_000_000_000,
  });

  const result = await importCapsule({
    archivePath: exported.archivePath,
    root: dstDir,
    mode: "skip",
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.length, 0);
  const content = await readFile(path.join(dstDir, "facts", "fact-ok.md"), "utf-8");
  assert.match(content, /Normal capsule fact\./);
});
