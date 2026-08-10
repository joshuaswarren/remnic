import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";

async function withStorage(run: (storage: StorageManager) => Promise<void>): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-frontmatter-cas-"));
  try {
    await run(new StorageManager(memoryDir));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("writeMemoryFrontmatterIfUnchanged rejects a semantic concurrent change", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The source snapshot must remain stable.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    assert.equal(await storage.writeMemoryFrontmatter(expected, { status: "archived" }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.9, level: "high", reasons: ["test"], keywords: [] },
      }),
      false,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "archived");
    assert.notEqual(current.frontmatter.importance?.score, 0.9);
  });
});
test("supersedeMemory rejects a semantic change after snapshot lookup", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The supersession source must remain stable.", { source: "test" });
    const replacement = await storage.writeMemory("fact", "The replacement must remain stable.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    const seams = storage as unknown as {
      withTombstoneBlockedMemoryPathLock: (...args: never[]) => Promise<unknown>;
    };
    const originalLock = seams.withTombstoneBlockedMemoryPathLock.bind(storage);
    let injected = false;
    seams.withTombstoneBlockedMemoryPathLock = async (...args) => {
      const [pathname, task, additionalPathnames] = args as unknown as [
        string,
        (current: unknown) => Promise<unknown>,
        readonly string[] | undefined,
      ];
      if (!injected) {
        injected = true;
        seams.withTombstoneBlockedMemoryPathLock = originalLock;
        assert.equal(
          await storage.writeMemoryFrontmatter(expected, {
            importance: { score: 0.4, level: "normal", reasons: ["concurrent"], keywords: [] },
          }),
          true,
        );
      }
      return originalLock(pathname as never, task as never, additionalPathnames as never);
    };

    assert.equal(
      await storage.supersedeMemory(
        created.id,
        replacement.id,
        "dependency_propagation:contradiction",
        { supersessionCause: "dependency", invalidatedBy: created.id },
        { requireActive: true, acceptExactReplay: true, expectedSnapshot: expected },
      ),
      false,
    );
    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "active");
    assert.equal(current.frontmatter.supersededBy, undefined);
    assert.equal(current.frontmatter.importance?.score, 0.4);
  });
});

test("writeMemoryFrontmatterIfUnchanged preserves access-only updates", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Access telemetry is not semantic content.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    const lastAccessed = "2026-08-10T00:00:00.000Z";
    assert.equal(await storage.writeMemoryFrontmatter(expected, { accessCount: 3, lastAccessed }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.8, level: "high", reasons: ["test"], keywords: [] },
      }),
      true,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.importance?.score, 0.8);
    assert.equal(current.frontmatter.accessCount, 3);
    assert.equal(current.frontmatter.lastAccessed, lastAccessed);
  });
});
