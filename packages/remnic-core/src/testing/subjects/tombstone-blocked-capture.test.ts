/**
 * Tombstone-blocked-capture lifecycle subject for the scenario-matrix harness
 * (issue #1993). Every row drives the real durable targeted index so coverage
 * cannot be satisfied by mapping this stateful path to an unrelated subject.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryFile } from "../../types.js";
import { StorageManager } from "../../storage.js";
import { ContentHashIndex } from "../../storage/content-hash-index.js";
import { buildExplicitCaptureDedupKey } from "../../storage/tombstone-blocked-capture-index.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface TombstoneLifecycleState {
  readonly memoryDir: string;
  readonly stateDir: string;
  storage: StorageManager;
}

async function readMemory(storage: StorageManager, id: string): Promise<MemoryFile> {
  const memory = (await storage.readAllMemories()).find((entry) => entry.frontmatter.id === id);
  assert.ok(memory, `expected persisted lifecycle memory ${id}`);
  return memory;
}

async function addBlocked(
  state: TombstoneLifecycleState,
  content: string,
  sourceConnector: string | undefined
): Promise<MemoryFile> {
  const result = await state.storage.writeMemory("fact", content, {
    source: "explicit-inline-review",
    confidence: 0.2,
    tags: ["review"],
    status: "pending_review",
    contentHashSource: content,
    ...(sourceConnector === undefined ? {} : { sourceConnector }),
  });
  const pending = await readMemory(state.storage, result.id);
  await state.storage.writeMemoryFrontmatter(pending, {
    status: "pending_review",
    blockedBy: "tombstone-1",
    tombstoneBlockTier: "exact",
  });
  return await readMemory(state.storage, result.id);
}

async function assertMembership(
  state: TombstoneLifecycleState,
  content: string,
  sourceConnector: string | undefined,
  expected: boolean
): Promise<void> {
  const result = await state.storage.checkTombstoneBlockedExplicitCapture(content, "fact", sourceConnector);
  assert.equal(result.has, expected);
  assert.equal(result.authoritative, true, "a published index must answer authoritatively");
}

const subject: LifecycleSubject<TombstoneLifecycleState> = {
  async setup(row: MatrixRow): Promise<TombstoneLifecycleState> {
    const memoryDir = await mkTempMemoryDir(`tombstone-${row.id}`);
    try {
      const stateDir = path.join(memoryDir, "state");
      return {
        memoryDir,
        stateDir,
        storage: new StorageManager(memoryDir),
      };
    } catch (err) {
      await cleanupDir(memoryDir);
      throw err;
    }
  },
  async exercise(state: TombstoneLifecycleState, row: MatrixRow): Promise<void> {
    const content = `The tombstone lifecycle row is ${row.id}.`;
    switch (row.id) {
      case "explicit-provider-identity":
        await addBlocked(state, content, "openclaw");
        return;
      case "sparse-metadata-with-binding":
        await addBlocked(state, content, undefined);
        return;
      case "sparse-metadata-without-binding":
        await addBlocked(state, content, "remembered-provider");
        return;
      case "provider-rebinding": {
        const before = await addBlocked(state, content, "provider-a");
        await state.storage.writeMemoryFrontmatter(before, {
          sourceConnector: "provider-b",
        });
        return;
      }
      case "restart-reload-recovery": {
        await addBlocked(state, content, "openclaw");
        state.storage = new StorageManager(state.memoryDir);
        return;
      }
      case "compaction-flush":
        await addBlocked(state, `${content} First.`, "openclaw");
        await addBlocked(state, `${content} Second.`, "openclaw");
        return;
      case "before-reset": {
        const before = await addBlocked(state, content, "openclaw");
        await state.storage.writeMemoryFrontmatter(before, {
          status: "active",
          blockedBy: undefined,
          tombstoneBlockTier: undefined,
        });
        return;
      }
      case "session-end":
        await addBlocked(state, content, "openclaw");
        await state.storage.checkTombstoneBlockedExplicitCapture(content, "fact", "openclaw");
        return;
      case "dedupe-replay":
        await addBlocked(state, content, "openclaw");
        await addBlocked(state, content, "openclaw");
        return;
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: TombstoneLifecycleState, row: MatrixRow): Promise<void> {
    const content = `The tombstone lifecycle row is ${row.id}.`;
    switch (row.id) {
      case "explicit-provider-identity":
      case "sparse-metadata-with-binding":
      case "restart-reload-recovery":
      case "session-end": {
        const sourceConnector = row.id === "sparse-metadata-with-binding" ? undefined : "openclaw";
        await assertMembership(state, content, sourceConnector, true);
        return;
      }
      case "sparse-metadata-without-binding":
        await assertMembership(state, content, undefined, false);
        await assertMembership(state, content, "remembered-provider", true);
        return;
      case "provider-rebinding":
        await assertMembership(state, content, "provider-a", false);
        await assertMembership(state, content, "provider-b", true);
        return;
      case "compaction-flush":
        await assertMembership(state, `${content} First.`, "openclaw", true);
        await assertMembership(state, `${content} Second.`, "openclaw", true);
        return;
      case "before-reset":
        await assertMembership(state, content, "openclaw", false);
        return;
      case "dedupe-replay": {
        await assertMembership(state, content, "openclaw", true);
        const raw = await readFile(path.join(state.stateDir, "tombstone-blocked-capture", "fact-hashes.txt"), "utf8");
        const keyHash = ContentHashIndex.computeHash(buildExplicitCaptureDedupKey(content, "fact", "openclaw"));
        assert.equal(
          raw
            .trim()
            .split("\n")
            .filter((line) => line === keyHash).length,
          1
        );
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(state: TombstoneLifecycleState): Promise<void> {
    await cleanupDir(state.memoryDir);
  },
};

runLifecycleMatrix("tombstone-blocked-capture", subject);
