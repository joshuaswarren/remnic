import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readStoreFileBuffer } from "./entity-file-read.js";

test("readStoreFileBuffer refuses an entities symlink outside the memory dir (C2)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-store-read-c2-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-store-read-c2-out-"));
  try {
    await mkdir(path.join(root, "entities"), { recursive: true });
    await writeFile(path.join(root, "entities", "alice.md"), "inside-ok\n");
    await writeFile(path.join(outside, "secret.md"), "OUTSIDE_SECRET\n");
    await symlink(path.join(outside, "secret.md"), path.join(root, "entities", "evil.md"));

    await assert.rejects(
      () => readStoreFileBuffer(path.join(root, "entities", "evil.md"), root),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, "ELOOP");
        return true;
      },
    );
    assert.equal(
      (await readStoreFileBuffer(path.join(root, "entities", "alice.md"), root)).toString("utf8"),
      "inside-ok\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
