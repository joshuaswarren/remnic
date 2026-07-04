/**
 * Catalog write-chokepoint fitness test (issue #1522).
 *
 * Exercises EVERY public storage write entry point on StorageManager and
 * asserts the catalog row's `lastWriteAt` moved for exactly the target
 * namespace. This is the regression contract: a future direct-write path that
 * skips the post-write hook will fail this test.
 *
 * Asserts via the persisted catalog row (`getNamespaceRecord().lastWriteAt`),
 * NOT return values — `markWrite`/`markRead` return `Promise<void>` and the
 * touch boolean is discarded by design.
 *
 * The touch is fire-and-forget from the StorageManager's perspective; the test
 * awaits it deterministically via `router.whenWriteTouchesSettled()` rather
 * than racing a timer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createStorageFixture, type StorageContractFixture } from "./helpers.js";
import type { MemorySummary } from "../../packages/remnic-core/src/types.js";

const TARGET_NS = "default";
const OTHER_NS = "other-namespace";

/**
 * Assert that calling `write` moved lastWriteAt for the target namespace
 * and did NOT move it for the other namespace. Awaits the fire-and-forget
 * touch via the router's settle signal.
 */
async function assertWriteTouch(
  fixture: StorageContractFixture,
  label: string,
  write: () => Promise<unknown>,
): Promise<void> {
  const beforeTarget = await fixture.lastWriteAt(TARGET_NS);
  const beforeOther = await fixture.lastWriteAt(OTHER_NS);
  await write();
  await fixture.settleWriteTouches();
  const afterTarget = await fixture.lastWriteAt(TARGET_NS);
  const afterOther = await fixture.lastWriteAt(OTHER_NS);
  assert.notEqual(
    afterTarget,
    beforeTarget,
    `${label}: target namespace lastWriteAt did not move (chokepoint skipped)`,
  );
  assert.equal(
    afterOther,
    beforeOther,
    `${label}: other namespace lastWriteAt should NOT move`,
  );
}

test("chokepoint: writeMemory advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeMemory", () =>
      storage.writeMemory("fact", "test fact from fitness suite", { confidence: 0.9 }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeChunk advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    const parentId = await storage.writeMemory("fact", "parent memory for chunking", {
      confidence: 0.9,
    });
    // Reset — the parent write already touched; now test the chunk write.
    await fixture.settleWriteTouches();
    const beforeChunk = await fixture.lastWriteAt(TARGET_NS);
    await storage.writeChunk(parentId, 0, 1, "fact", "chunk content", { confidence: 0.8 });
    await fixture.settleWriteTouches();
    const afterChunk = await fixture.lastWriteAt(TARGET_NS);
    assert.notEqual(afterChunk, beforeChunk, "writeChunk did not advance lastWriteAt");
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeEntity advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeEntity", () =>
      storage.writeEntity("TestEntity", "person", ["a fact about the entity"], {}),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeArtifact advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeArtifact", () =>
      storage.writeArtifact("test artifact", { confidence: 0.7 }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeProfile advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeProfile", () =>
      storage.writeProfile("# Profile\n\nTest profile content."),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: appendToProfile advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await storage.writeProfile("# Profile\n\nBase.");
    await fixture.settleWriteTouches();
    await assertWriteTouch(fixture, "appendToProfile", () =>
      storage.appendToProfile(["- appended line"]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeSummary advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeSummary", () =>
      storage.writeSummary({
        id: "summary-test",
        createdAt: new Date().toISOString(),
        timeRangeStart: new Date().toISOString(),
        timeRangeEnd: new Date().toISOString(),
        summaryText: "test summary",
        keyFacts: [],
        keyEntities: [],
        sourceEpisodeIds: [],
      }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeQuestion advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeQuestion", () =>
      storage.writeQuestion("What is the meaning of life?", "Testing questions", 5),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: saveBuffer advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "saveBuffer", () =>
      storage.saveBuffer({
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: appendMemoryLifecycleEvents advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "appendMemoryLifecycleEvents", () =>
      storage.appendMemoryLifecycleEvents([
        {
          eventId: "mle-fitness-test",
          memoryId: "mem-test",
          eventType: "test_event",
          timestamp: new Date().toISOString(),
          actor: "test",
          reasonCode: "fitness",
          ruleVersion: "test.v1",
        } satisfies Record<string, unknown> as never,
      ]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeCompressionGuidelines advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeCompressionGuidelines", () =>
      storage.writeCompressionGuidelines("# Guidelines\n\nTest."),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeIdentityAnchor advances the catalog lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeIdentityAnchor", () =>
      storage.writeIdentityAnchor("# Identity Anchor\n\nTest."),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: writeOfflineSyncFile advances the catalog lastWriteAt (import path)", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const storage = await fixture.storageFor(TARGET_NS);
    await assertWriteTouch(fixture, "writeOfflineSyncFile", () =>
      storage.writeOfflineSyncFile(
        path.join(storage.dir, "import", "test.json"),
        Buffer.from("test content"),
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chokepoint: namespace isolation — a write to one namespace does not move another's lastWriteAt", async () => {
  const fixture = await createStorageFixture(TARGET_NS, {
    namespacesEnabled: true,
    namespacePolicies: [{ name: OTHER_NS, kind: "explicit" }],
  });
  try {
    const targetStorage = await fixture.storageFor(TARGET_NS);
    // Ensure OTHER_NS is registered but untouched.
    await fixture.storageFor(OTHER_NS);
    await fixture.router.whenResolveHooksSettled();

    const beforeOther = await fixture.lastWriteAt(OTHER_NS);
    await targetStorage.writeProfile("# Target profile\n\nWrite to target only.");
    await fixture.settleWriteTouches();
    const afterOther = await fixture.lastWriteAt(OTHER_NS);

    assert.equal(
      afterOther,
      beforeOther,
      "OTHER_NS lastWriteAt should NOT move when writing to TARGET_NS",
    );
  } finally {
    await fixture.cleanup();
  }
});
