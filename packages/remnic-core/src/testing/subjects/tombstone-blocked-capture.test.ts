/**
 * Tombstone-blocked-capture lifecycle subject for the scenario-matrix harness
 * (issue #1993). Every row drives the real durable targeted index so coverage
 * cannot be satisfied by mapping this stateful path to an unrelated subject.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryFile, MemoryFrontmatter } from "../../types.js";
import { ContentHashIndex } from "../../storage/content-hash-index.js";
import {
  TombstoneBlockedCaptureIndex,
  buildExplicitCaptureDedupKey,
} from "../../storage/tombstone-blocked-capture-index.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface TombstoneLifecycleState {
  readonly memoryDir: string;
  readonly stateDir: string;
  memories: MemoryFile[];
  index: TombstoneBlockedCaptureIndex;
}

function memoryFile(
  id: string,
  content: string,
  sourceConnector: string | undefined,
  blocked = true,
): MemoryFile {
  const frontmatter: MemoryFrontmatter = {
    id,
    category: "fact",
    created: "2026-07-25T00:00:00.000Z",
    updated: "2026-07-25T00:00:00.000Z",
    source: "explicit-inline",
    confidence: 0.95,
    confidenceTier: "explicit",
    tags: [],
    ...(sourceConnector === undefined ? {} : { sourceConnector }),
    ...(blocked
      ? {
          status: "pending_review" as const,
          blockedBy: "tombstone-1",
          tombstoneBlockTier: "exact" as const,
        }
      : { status: "active" as const }),
  };
  return {
    path: path.join("facts", `${id}.md`),
    frontmatter,
    content,
  };
}

function createIndex(
  stateDir: string,
  memoryDir: string,
  memories: MemoryFile[],
): TombstoneBlockedCaptureIndex {
  return new TombstoneBlockedCaptureIndex({
    stateDir,
    memoryDir,
    secureStoreKeyProvider: () => null,
    secureStoreWriteKeyProvider: () => null,
    lockOptions: () => ({ maxWaitMs: 500, pollMs: 5, retryBaseMs: 5, retryMaxAttempts: 3 }),
    readAllMemories: async () => memories,
    readAllColdMemories: async () => [],
  });
}

async function addBlocked(
  state: TombstoneLifecycleState,
  id: string,
  content: string,
  sourceConnector: string | undefined,
): Promise<MemoryFile> {
  const memory = memoryFile(id, content, sourceConnector);
  state.memories.push(memory);
  await state.index.add(memory);
  return memory;
}

async function assertMembership(
  state: TombstoneLifecycleState,
  content: string,
  sourceConnector: string | undefined,
  expected: boolean,
): Promise<void> {
  const result = await state.index.check(content, "fact", sourceConnector);
  assert.equal(result.has, expected);
  assert.equal(result.authoritative, true, "a published index must answer authoritatively");
}

const subject: LifecycleSubject<TombstoneLifecycleState> = {
  async setup(row: MatrixRow): Promise<TombstoneLifecycleState> {
    const memoryDir = await mkTempMemoryDir(`tombstone-${row.id}`);
    try {
      const stateDir = path.join(memoryDir, "state");
      const memories: MemoryFile[] = [];
      return {
        memoryDir,
        stateDir,
        memories,
        index: createIndex(stateDir, memoryDir, memories),
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
        await addBlocked(state, "explicit", content, "openclaw");
        return;
      case "sparse-metadata-with-binding":
        await addBlocked(state, "remembered", content, undefined);
        return;
      case "sparse-metadata-without-binding":
        await addBlocked(state, "unbound", content, "remembered-provider");
        return;
      case "provider-rebinding": {
        const before = await addBlocked(state, "rebind", content, "provider-a");
        const after = memoryFile("rebind", content, "provider-b");
        state.memories[0] = after;
        await state.index.sync(before, after);
        return;
      }
      case "restart-reload-recovery": {
        await addBlocked(state, "restart", content, "openclaw");
        state.index = createIndex(state.stateDir, state.memoryDir, state.memories);
        return;
      }
      case "compaction-flush":
        await addBlocked(state, "compact-a", `${content} First.`, "openclaw");
        await addBlocked(state, "compact-b", `${content} Second.`, "openclaw");
        return;
      case "before-reset": {
        const before = await addBlocked(state, "reset", content, "openclaw");
        const after = memoryFile("reset", content, "openclaw", false);
        state.memories[0] = after;
        await state.index.sync(before, after);
        return;
      }
      case "session-end":
        await addBlocked(state, "session-end", content, "openclaw");
        await state.index.rebuildIfLoaded();
        return;
      case "dedupe-replay": {
        const memory = await addBlocked(state, "replay", content, "openclaw");
        await state.index.add(memory);
        return;
      }
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
        const raw = await readFile(
          path.join(state.stateDir, "tombstone-blocked-capture", "fact-hashes.txt"),
          "utf8",
        );
        const keyHash = ContentHashIndex.computeHash(buildExplicitCaptureDedupKey(content, "fact", "openclaw"));
        assert.equal(raw.trim().split("\n").filter((line) => line === keyHash).length, 1);
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
