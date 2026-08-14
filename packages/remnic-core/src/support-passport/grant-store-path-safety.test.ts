import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SupportPassportGrantStore } from "./grant-store.js";

test("owner membership setup rejects a swapped memory-directory ancestor before mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-ancestor-"));
  const liveParent = path.join(root, "live");
  const memoryDir = path.join(liveParent, "memory");
  const originalParent = path.join(root, "original");
  const outsideParent = path.join(root, "outside");
  try {
    const store = new SupportPassportGrantStore({ memoryDir });
    await store.listForOwner("alice", "owner:alice");
    await mkdir(path.join(outsideParent, "memory"), { recursive: true });
    await rename(liveParent, originalParent);
    await symlink(outsideParent, liveParent, "dir");

    await assert.rejects(store.listForOwner("alice", "owner:alice"));
    await assert.rejects(
      lstat(path.join(outsideParent, "memory", "state")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
