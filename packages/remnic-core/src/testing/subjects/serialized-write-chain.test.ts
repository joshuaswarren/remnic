/**
 * Serialized-write-chain lifecycle subject for the scenario-matrix harness
 * (issue #1993, PR2). The session-toggle store (session-toggles.ts) is §28's
 * origin — a session-scoped, restart-recoverable subsystem whose durability
 * hinges on a serialized write chain (`queueWrite`) that must not lose an
 * update under concurrent read-modify-write. Retrofitted as the second
 * reference `LifecycleSubject` so the matrix's concurrency/restart rows guard
 * that chain directly.
 *
 * The nine rows are realized honestly against the store's real behavior — no
 * mocks: identity binding, remembered vs sparse bindings, rebinding, restart
 * reload, burst compaction, concurrent flush ordering, and idempotent replay.
 */

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFileToggleStore, type SessionToggleStore } from "../../session-toggles.js";
import { mkTempMemoryDir } from "../orchestrator-lite.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface SerializedWriteState {
  dir: string;
  filePath: string;
  store: SessionToggleStore;
}

const AGENT = "engram";

/** Read the raw persisted toggle file (validates it is well-formed JSON). */
async function readToggleFileEntries(filePath: string): Promise<Record<string, { disabled: boolean }>> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed &&
    typeof parsed === "object" &&
    "entries" in parsed &&
    parsed.entries &&
    typeof parsed.entries === "object"
  ) {
    return parsed.entries as Record<string, { disabled: boolean }>;
  }
  throw new Error(`toggle file is not a well-formed ToggleFile: ${raw}`);
}

const subject: LifecycleSubject<SerializedWriteState> = {
  async setup(row: MatrixRow): Promise<SerializedWriteState> {
    const dir = await mkTempMemoryDir(`toggles-${row.id}`);
    try {
      const filePath = path.join(dir, "session-toggles.json");
      return { dir, filePath, store: createFileToggleStore(filePath) };
    } catch (err) {
      // Transactional setup: a partial build must not leak the temp dir.
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  },

  async exercise(state: SerializedWriteState, row: MatrixRow): Promise<void> {
    switch (row.id) {
      case "explicit-provider-identity": {
        await state.store.setDisabled("session-explicit", AGENT, true);
        return;
      }
      case "sparse-metadata-with-binding": {
        // A binding remembered on disk from a prior session — no write in THIS
        // session, yet the sparse lookup resolves it through the persisted file.
        await writeFile(
          state.filePath,
          JSON.stringify(
            {
              version: 1,
              entries: {
                [`${encodeURIComponent("session-remembered")}::${encodeURIComponent(AGENT)}`]: {
                  disabled: true,
                  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );
        return;
      }
      case "sparse-metadata-without-binding": {
        // No write, no seed — nothing to resolve.
        return;
      }
      case "provider-rebinding": {
        await state.store.setDisabled("session-rebind", AGENT, true);
        await state.store.setDisabled("session-rebind", AGENT, false);
        return;
      }
      case "restart-reload-recovery": {
        await state.store.setDisabled("session-restart", AGENT, true);
        // Simulate a restart: a brand-new store over the same file.
        state.store = createFileToggleStore(state.filePath);
        return;
      }
      case "compaction-flush": {
        for (let i = 0; i < 6; i += 1) {
          await state.store.setDisabled(`session-compact-${i}`, AGENT, true);
        }
        for (let i = 0; i < 6; i += 1) {
          await state.store.clear(`session-compact-${i}`, AGENT);
        }
        return;
      }
      case "before-reset": {
        // Serialized-write-chain core: fire many concurrent read-modify-write
        // toggles at once. The queue must apply every one — a broken chain
        // loses updates (last-writer-wins clobbering).
        await Promise.all(
          Array.from({ length: 12 }, (_unused, i) =>
            state.store.setDisabled(`session-burst-${i}`, AGENT, true),
          ),
        );
        return;
      }
      case "session-end": {
        // Concurrent set + clear on the SAME key, then a final drain. Ordering
        // is deterministic (queue order), and the file must stay well-formed.
        await Promise.all([
          state.store.setDisabled("session-final", AGENT, true),
          state.store.setDisabled("session-final", AGENT, false),
          state.store.clear("session-final", AGENT),
          state.store.setDisabled("session-final", AGENT, true),
        ]);
        return;
      }
      case "dedupe-replay": {
        await state.store.setDisabled("session-replay", AGENT, true);
        await state.store.setDisabled("session-replay", AGENT, true);
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: SerializedWriteState, row: MatrixRow): Promise<void> {
    switch (row.id) {
      case "explicit-provider-identity": {
        const resolved = await state.store.resolve("session-explicit", AGENT);
        assert.equal(resolved.disabled, true);
        assert.equal(resolved.source, "primary", "an explicit write binds the primary source");
        return;
      }
      case "sparse-metadata-with-binding": {
        const resolved = await state.store.resolve("session-remembered", AGENT);
        assert.equal(resolved.disabled, true, "the remembered binding resolves for a sparse lookup");
        assert.equal(resolved.source, "primary");
        return;
      }
      case "sparse-metadata-without-binding": {
        const resolved = await state.store.resolve("session-unknown", AGENT);
        assert.equal(resolved.disabled, false, "an unbound lookup must not fabricate a disabled state");
        assert.equal(resolved.source, "none");
        return;
      }
      case "provider-rebinding": {
        const resolved = await state.store.resolve("session-rebind", AGENT);
        assert.equal(resolved.disabled, false, "the rebind's last serialized write wins");
        return;
      }
      case "restart-reload-recovery": {
        const resolved = await state.store.resolve("session-restart", AGENT);
        assert.equal(resolved.disabled, true, "the restarted store reloads prior durable state");
        return;
      }
      case "compaction-flush": {
        const entries = await readToggleFileEntries(state.filePath);
        assert.equal(Object.keys(entries).length, 0, "clearing every key compacts the file to no entries");
        assert.equal((await state.store.list()).length, 0);
        return;
      }
      case "before-reset": {
        const entries = await readToggleFileEntries(state.filePath);
        assert.equal(
          Object.keys(entries).length,
          12,
          "the serialized write chain must apply every concurrent write — no lost update",
        );
        for (let i = 0; i < 12; i += 1) {
          const resolved = await state.store.resolve(`session-burst-${i}`, AGENT);
          assert.equal(resolved.disabled, true, `burst write ${i} must have survived`);
        }
        return;
      }
      case "session-end": {
        // The chain drains deterministically; the file is valid and the key's
        // final state is the last-queued write (setDisabled true).
        const entries = await readToggleFileEntries(state.filePath);
        const resolved = await state.store.resolve("session-final", AGENT);
        assert.equal(resolved.disabled, true, "the last serialized operation determines the final state");
        assert.ok(Object.keys(entries).length <= 1, "no torn/duplicate entries for the single key");
        return;
      }
      case "dedupe-replay": {
        const entries = await readToggleFileEntries(state.filePath);
        const matching = Object.keys(entries).filter((key) => key.includes(encodeURIComponent("session-replay")));
        assert.equal(matching.length, 1, "a replayed identical write is idempotent — one entry, not two");
        const resolved = await state.store.resolve("session-replay", AGENT);
        assert.equal(resolved.disabled, true);
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(state: SerializedWriteState): Promise<void> {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("serialized-write-chain", subject);
