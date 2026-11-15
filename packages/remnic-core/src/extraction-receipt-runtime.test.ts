import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bufferTurnIdentityKey, bufferTurnsEqual, copyBufferTurn } from "./buffer-turn-helpers.js";
import { admitExtractionReceipt } from "./extraction-receipt-admission.js";
import {
  blockReceiptCoverage,
  receiptPersisted,
  receiptProviderPayload,
  receiptProviderResult,
  receiptStorage,
  withExtractionReceipt,
} from "./extraction-receipt-runtime.js";
import { ExtractionReceiptStore } from "./extraction-receipts.js";
import { StorageManager } from "./storage.js";
import type { BufferTurn, ExtractionResult } from "./types.js";

// Exact pieces -> durable copy/restart -> writer success; provider failure/empty,
// partial write, filtered candidate, stale attempt, pending review, routed output
// and unresolved crash journal are independently incomplete outcomes.
async function fixture(t: import("node:test").TestContext, content = "abcdef", maxChars = 3) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const admitted = await admitExtractionReceipt({
    memoryDir: dir,
    chunk: { sourceDigest: "a".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    principal: "owner",
    namespace: "tenant",
    sessionKey: "session",
    scope: { project: "project-a" },
    messages: [{ role: "user", content }],
    turns: [
      { source: "openclaw", role: "user", sessionKey: "session", timestamp: "2026-01-01T00:00:00.000Z", content },
    ],
    maxChars,
  });
  return {
    dir,
    ...admitted,
    store: new ExtractionReceiptStore(dir),
    turns: admitted.turns.map((turn) => ({ ...turn })),
  };
}
const empty: ExtractionResult = { facts: [], entities: [], questions: [], profileUpdates: [], relationships: [] };
const fake = (dir: string, methods: Record<string, (...args: any[]) => any>) => {
  const storage = new StorageManager(dir);
  for (const [name, fn] of Object.entries(methods))
    Object.defineProperty(storage, name, {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        const result = await fn(...args);
        const subdir =
          name === "writeEntity"
            ? "entities"
            : name === "writeQuestion"
              ? "questions"
              : name === "writeArtifact"
                ? "artifacts/2026-01-01"
                : undefined;
        if (subdir && result) {
          await mkdir(path.join(dir, subdir), { recursive: true });
          await writeFile(path.join(dir, subdir, `${result}.md`), "synthetic durable artifact");
        }
        return result;
      },
    });
  return storage;
};

test("all exact pieces must finish; membership survives copy/JSON restart and differs in buffer identity", async (t) => {
  const f = await fixture(t);
  assert.equal(f.turns.length, 2);
  const first = copyBufferTurn(JSON.parse(JSON.stringify(f.turns[0])));
  assert.deepEqual(first.extractionReceiptMembers, f.turns[0]!.extractionReceiptMembers);
  const other = { ...first, extractionReceiptMembers: [{ receiptId: "different", memberId: "different" }] };
  assert.equal(bufferTurnsEqual(first, other), false);
  assert.notEqual(bufferTurnIdentityKey(first), bufferTurnIdentityKey(other));
  for (const [index, turn] of [first, f.turns[1]!].entries()) {
    await withExtractionReceipt(f.dir, [turn], 3, async () => {
      await receiptStorage(fake(f.dir, { writeEntity: async () => `entity-${index}` }), "tenant").writeEntity(
        "x",
        "concept",
        ["y"]
      );
      receiptPersisted(0, []);
    });
    assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, index === 1);
  }
  assert.deepEqual((await f.store.get(f.receipt.receiptId))!.artifacts.map((a) => a.id).sort(), [
    "entity-0",
    "entity-1",
  ]);
});

test("only explicit valid provider empty establishes empty success", async (t) => {
  for (const failed of [true, false]) {
    const f = await fixture(t, "abc");
    await withExtractionReceipt(f.dir, f.turns, 3, async () => {
      receiptProviderPayload(empty, empty);
      await receiptProviderResult({ ...empty, extractionFailure: failed ? "provider unavailable" : undefined });
    });
    assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, !failed);
  }
});

test("partial persistence preserves actual IDs but cannot establish coverage", async (t) => {
  const f = await fixture(t, "abc");
  await assert.rejects(
    withExtractionReceipt(f.dir, f.turns, 3, async () => {
      const storage = receiptStorage(
        fake(f.dir, {
          writeEntity: async () => "entity-one",
          writeQuestion: async () => {
            throw new Error("disk failure");
          },
        }),
        "tenant"
      );
      await storage.writeEntity("x", "concept", ["y"]);
      await storage.writeQuestion("why", "context", 1);
    }),
    /disk failure/
  );
  const receipt = (await f.store.get(f.receipt.receiptId))!;
  assert.equal(receipt.coverageComplete, false);
  assert.equal(receipt.artifacts[0]!.id, "entity-one");
  assert.equal(
    receipt.members[0]!.journal.some((j) => !j.confirmed),
    true
  );
});

test("filtered/pending/routed output never claims full coverage", async (t) => {
  for (const mode of ["filtered", "pending", "routed"]) {
    const f = await fixture(t, "abc");
    await withExtractionReceipt(f.dir, f.turns, 3, async () => {
      await receiptStorage(
        fake(f.dir, { writeEntity: async () => "entity-one" }),
        mode === "routed" ? "other" : "tenant"
      ).writeEntity("x", "concept", ["y"]);
      if (mode === "filtered") blockReceiptCoverage();
      receiptPersisted(0, mode === "pending" ? ["entity-one"] : []);
    });
    assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, false);
  }
});

test("void writers remain unconfirmed even when other kinds persist", async (t) => {
  const f = await fixture(t, "abc");
  await withExtractionReceipt(f.dir, f.turns, 3, async () => {
    const storage = receiptStorage(
      fake(f.dir, {
        writeEntity: async () => "entity",
        writeQuestion: async () => "question",
        writeArtifact: async () => "artifact",
        addEntityRelationship: async () => {},
        appendToProfile: async () => {},
        appendIdentityReflection: async () => {},
      }),
      "tenant"
    );
    await storage.writeEntity("x", "concept", ["y"]);
    await storage.writeQuestion("why", "context", 1);
    await storage.writeArtifact("quote");
    await storage.addEntityRelationship("x", { target: "y", label: "uses" });
    await storage.appendToProfile(["profile"]);
    await storage.appendIdentityReflection("identity");
    receiptPersisted(0, []);
  });
  const receipt = (await f.store.get(f.receipt.receiptId))!;
  assert.equal(receipt.coverageComplete, false);
  assert.deepEqual(receipt.artifacts.map((a) => a.kind).sort(), ["artifact", "entity", "question"]);
  assert.equal(receipt.members[0]!.journal.filter((j) => !j.confirmed).length, 3);
});

test("malformed/partial provider objects and normalized-away candidates cannot become empty success", async (t) => {
  for (const raw of [
    { facts: [] },
    { ...empty, relationships: {} },
    { ...empty, identityReflection: 1 },
    { ...empty, facts: [{ content: "discarded" }] },
  ]) {
    const f = await fixture(t, "abc");
    await withExtractionReceipt(f.dir, f.turns, 3, async () => {
      receiptProviderPayload(raw, empty);
      await receiptProviderResult(empty);
    });
    assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, false);
  }
});

test("relationship cap truncation remains incomplete despite confirmed entity output", async (t) => {
  const { limitedExtractionOutputs } = await import("./orchestration/extraction-persist-output-limits.js");
  const { parseConfig } = await import("./config.js");
  const f = await fixture(t, "abc");
  await withExtractionReceipt(f.dir, f.turns, 3, async () => {
    const result = {
      ...empty,
      relationships: Array.from({ length: 6 }, (_, i) => ({ source: "a", target: `b${i}`, label: "uses" })),
    };
    limitedExtractionOutputs(result, parseConfig({ memoryDir: f.dir, entityRelationshipsEnabled: true }));
    await receiptStorage(fake(f.dir, { writeEntity: async () => "entity" }), "tenant").writeEntity("x", "concept", [
      "y",
    ]);
    receiptPersisted(0, []);
  });
  assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, false);
});

test("real identity cooldown and missing relationship remain incomplete", async (t) => {
  for (const operation of ["identity", "relationship"] as const) {
    const f = await fixture(t, "abc");
    const storage = new StorageManager(f.dir);
    await storage.ensureDirectories();
    if (operation === "identity") await storage.appendIdentityReflection("Existing synthetic reflection.");
    const before = await storage.readIdentityReflections();
    await withExtractionReceipt(f.dir, f.turns, 3, async () => {
      const wrapped = receiptStorage(storage, "tenant");
      if (operation === "identity")
        await wrapped.appendIdentityReflection("This reflection is suppressed by cooldown.");
      else
        await wrapped.addEntityRelationship("missing-synthetic-entity", {
          target: "another-missing-entity",
          label: "related",
        });
      receiptPersisted(0, []);
    });
    assert.equal((await f.store.get(f.receipt.receiptId))?.coverageComplete, false);
    assert.equal(await storage.readIdentityReflections(), before);
    assert.equal((await f.store.get(f.receipt.receiptId))?.artifacts.length, 0);
  }
});

test("memory evidence must match writer ID and exact file path", async (t) => {
  const f = await fixture(t, "abc");
  const { syncReceiptArtifact } = await import("./extraction-receipt-artifact-sync.js");
  const storage = new StorageManager(f.dir);
  const filename = path.join(f.dir, "unrelated.md");
  await writeFile(filename, "an unrelated existing file");
  assert.equal(
    await syncReceiptArtifact(storage, "memory", "expected", {
      id: "expected",
      memory: { path: filename, frontmatter: { id: "unrelated" } },
    }),
    false
  );
  assert.equal(
    await syncReceiptArtifact(storage, "memory", "expected", {
      id: "expected",
      memory: { path: filename, frontmatter: { id: "expected" } },
    }),
    false
  );
  const outside = path.join(path.dirname(f.dir), "expected.md");
  assert.equal(
    await syncReceiptArtifact(storage, "memory", "expected", {
      id: "expected",
      memory: { path: outside, frontmatter: { id: "expected" } },
    }),
    false
  );
});

for (const interrupted of [false, true])
  test(`real entity writer ${interrupted ? "interrupted retry subset stays incomplete" : "fresh proof remains supported"}`, async (t) => {
    const f = await fixture(t, "abc");
    const storage = new StorageManager(f.dir);
    const result: ExtractionResult = {
      ...empty,
      entities: [{ name: "Synthetic", type: "other", facts: ["Synthetic fact"] }],
    };
    const run = (providerResult = result) =>
      withExtractionReceipt(f.dir, f.turns, 3, async () => {
        receiptProviderPayload(providerResult, providerResult);
        await receiptProviderResult(providerResult);
        await receiptStorage(storage, "tenant").writeEntity("Synthetic", "other", ["Synthetic fact"]);
        receiptPersisted(0, []);
      });
    if (interrupted) {
      const confirm = ExtractionReceiptStore.prototype.confirmArtifact;
      ExtractionReceiptStore.prototype.confirmArtifact = async () => {
        throw new Error("synthetic entity interruption");
      };
      try {
        await assert.rejects(
          run({
            ...result,
            entities: [...result.entities, { name: "Other", type: "other", facts: ["Unprocessed synthetic fact"] }],
          }),
          /synthetic entity interruption/
        );
      } finally {
        ExtractionReceiptStore.prototype.confirmArtifact = confirm;
      }
    }
    await run();
    assert.equal((await f.store.get(f.receipt.receiptId))!.coverageComplete, !interrupted);
  });
