/**
 * Unit tests for `forgetMemory` (issue #686 PR 4/6).
 *
 * Pure helper-level coverage — uses a minimal in-memory storage stub
 * so the test focuses on the forget pipeline (find by id → write
 * frontmatter → return result) without booting an orchestrator.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import {
  forgetMemory,
  ForgetMemoryAlreadyForgottenError,
  ForgetMemoryNotFoundError,
} from "./forget.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { StorageManager, type MemoryLifecycleEventWriteOptions } from "../storage.js";

interface StubWriteCall {
  memoryId: string;
  patch: Partial<MemoryFrontmatter>;
  lifecycle?: MemoryLifecycleEventWriteOptions;
}

function makeMemory(overrides: Partial<MemoryFrontmatter> = {}): MemoryFile {
  return {
    path: `/tmp/mem/${overrides.id ?? "mem-1"}.md`,
    content: "synthetic body",
    frontmatter: {
      id: "mem-1",
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      ...overrides,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(
  memories: MemoryFile[],
  tiers: { archived?: MemoryFile[]; cold?: MemoryFile[] } = {},
) {
  const writes: StubWriteCall[] = [];
  const stub = {
    readAllMemories: async () => memories,
    readArchivedMemories: async () => tiers.archived ?? [],
    readAllColdMemories: async () => tiers.cold ?? [],
    writeMemoryFrontmatter: async (
      memory: MemoryFile,
      patch: Partial<MemoryFrontmatter>,
      lifecycle?: MemoryLifecycleEventWriteOptions,
    ) => {
      writes.push({ memoryId: memory.frontmatter.id, patch, lifecycle });
      return true;
    },
  };
  return { stub: stub as unknown as StorageManager, writes };
}

test("forgetMemory: marks active memory as forgotten with timestamp + reason", async () => {
  const mem = makeMemory({ id: "alpha", status: "active" });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub, {
    id: "alpha",
    reason: "stale preference",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.id, "alpha");
  assert.equal(result.path, "/tmp/mem/alpha.md");
  assert.equal(result.priorStatus, "active");
  assert.equal(result.forgottenAt, "2026-04-25T12:00:00.000Z");
  assert.equal(result.reason, "stale preference");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.memoryId, "alpha");
  assert.equal(writes[0]?.patch.status, "forgotten");
  assert.equal(writes[0]?.patch.forgottenAt, "2026-04-25T12:00:00.000Z");
  assert.equal(writes[0]?.patch.forgottenReason, "stale preference");
  assert.equal(writes[0]?.patch.updated, "2026-04-25T12:00:00.000Z");
  assert.deepEqual(writes[0]?.lifecycle, {
    actor: "remnic-forget",
    reasonCode: "operator_forget",
  });
});

test("forgetMemory: clears forgottenReason when reason is empty", async () => {
  const mem = makeMemory({
    id: "beta",
    status: "active",
    forgottenReason: "stale restored reason",
  });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub, {
    id: "beta",
    reason: "   ",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.reason, "");
  assert.ok(
    Object.hasOwn(writes[0]?.patch ?? {}, "forgottenReason"),
    "patch must explicitly clear stale merged frontmatter",
  );
  assert.equal(writes[0]?.patch.forgottenReason, undefined);
});

test("forgetMemory: throws ForgetMemoryNotFoundError on unknown id", async () => {
  const { stub } = makeStorageStub([makeMemory({ id: "gamma" })]);
  await assert.rejects(
    forgetMemory(stub, { id: "no-such-id" }),
    (err: unknown) => err instanceof ForgetMemoryNotFoundError,
  );
});

test("forgetMemory: throws ForgetMemoryAlreadyForgottenError on already-forgotten", async () => {
  const mem = makeMemory({
    id: "delta",
    status: "forgotten",
    forgottenAt: "2026-04-20T00:00:00.000Z",
  });
  const { stub } = makeStorageStub([mem]);
  await assert.rejects(
    forgetMemory(stub, { id: "delta" }),
    (err: unknown) =>
      err instanceof ForgetMemoryAlreadyForgottenError &&
      err.message.includes("2026-04-20T00:00:00.000Z"),
  );
});

test("forgetMemory: rejects empty/whitespace id", async () => {
  const { stub } = makeStorageStub([makeMemory({ id: "epsilon" })]);
  await assert.rejects(forgetMemory(stub, { id: "" }), /required/);
  await assert.rejects(forgetMemory(stub, { id: "   " }), /required/);
});

test("forgetMemory: trims whitespace from id and reason", async () => {
  const mem = makeMemory({ id: "zeta", status: "active" });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub, {
    id: "  zeta  ",
    reason: "  bad data  ",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.id, "zeta");
  assert.equal(result.reason, "bad data");
  assert.equal(writes[0]?.patch.forgottenReason, "bad data");
});

test("forgetMemory: preserves prior non-active status in result", async () => {
  const mem = makeMemory({ id: "eta", status: "archived" });
  const { stub } = makeStorageStub([mem]);
  const result = await forgetMemory(stub, {
    id: "eta",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.priorStatus, "archived");
});

test("forgetMemory: resolves archived and cold tier memories by id", async () => {
  const archived = makeMemory({ id: "theta", status: "archived" });
  const cold = makeMemory({ id: "iota", status: "active" });
  const archivedStub = makeStorageStub([], { archived: [archived] });
  const archivedResult = await forgetMemory(archivedStub.stub, {
    id: "theta",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(archivedResult.id, "theta");
  assert.equal(archivedStub.writes[0]?.memoryId, "theta");

  const coldStub = makeStorageStub([], { cold: [cold] });
  const coldResult = await forgetMemory(coldStub.stub, {
    id: "iota",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(coldResult.id, "iota");
  assert.equal(coldStub.writes[0]?.memoryId, "iota");
});

test("forgetMemory: forgotten metadata survives storage round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-forget-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id: id } = await storage.writeMemory("fact", "Synthetic fact to forget.", {
      source: "test",
      tags: ["roundtrip"],
    });

    await forgetMemory(storage, {
      id,
      reason: "contains stale: quoted \"value\"",
      now: () => new Date("2026-04-25T12:00:00Z"),
    });

    const reloaded = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(reloaded, "forgotten memory should still exist during retention window");
    assert.equal(reloaded!.frontmatter.status, "forgotten");
    assert.equal(reloaded!.frontmatter.forgottenAt, "2026-04-25T12:00:00.000Z");
    assert.equal(reloaded!.frontmatter.forgottenReason, "contains stale: quoted \"value\"");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
