import assert from "node:assert/strict";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";

import { type WindowedMemoryReadResult } from "../../storage/windowed-memory-read.js";
import { StorageManager } from "../../storage.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { mkTempMemoryDir } from "../orchestrator-lite.js";

type WindowResult = WindowedMemoryReadResult;
interface WindowedMemoryState {
  dir: string;
  storage: StorageManager;
  updatedAfter: Date;
  expectedIds: Set<string>;
  excludedIds: Set<string>;
  cold?: WindowResult;
  warm?: WindowResult;
  afterWrite?: WindowResult;
}

const UPDATED_AFTER = new Date("2021-01-01T00:00:00.000Z");
const INCLUDED = new Date("2021-01-02T00:00:00.000Z");
const BOUNDARY = UPDATED_AFTER.toISOString();
const OLD = new Date("2020-12-31T23:59:59.000Z").toISOString();

async function writeFixture(
  storage: StorageManager,
  content: string,
  editFrontmatter: (raw: string) => string,
): Promise<{ id: string; filePath: string }> {
  const written = await storage.writeMemory("fact", content);
  const raw = await readFile(written.memory.path, "utf8");
  await writeFile(written.memory.path, editFrontmatter(raw), "utf8");
  return { id: written.id, filePath: written.memory.path };
}

async function readColdThenWarm(state: WindowedMemoryState): Promise<void> {
  // The first window read must miss the process cache and exercise the real
  // path census/filter/parser. Populate the hot corpus cache explicitly, then
  // repeat the identical request through readWindowedMemories' warm branch.
  state.cold = await state.storage.readMemoriesWindow({ updatedAfter: state.updatedAfter });
  await state.storage.readAllMemories();
  state.warm = await state.storage.readMemoriesWindow({ updatedAfter: state.updatedAfter });
}

const subject: LifecycleSubject<WindowedMemoryState> = {
  async setup(row: MatrixRow): Promise<WindowedMemoryState> {
    const dir = await mkTempMemoryDir(`windowed-read-${row.id}`);
    try {
      const storage = new StorageManager(dir, undefined, true);
      await storage.ensureDirectories();
      const expectedIds = new Set<string>();
      const excludedIds = new Set<string>();

      const boundary = await writeFixture(storage, "boundary timestamp", (raw) =>
        raw.replace(/^updated:.*$/m, `updated: ${BOUNDARY}`),
      );
      expectedIds.add(boundary.id);

      const old = await writeFixture(storage, "outside lower boundary", (raw) =>
        raw.replace(/^updated:.*$/m, `updated: ${OLD}`),
      );
      excludedIds.add(old.id);

      const blankUpdated = await writeFixture(storage, "blank updated falls back to created", (raw) =>
        raw
          .replace(/^created:.*$/m, `created: ${INCLUDED.toISOString()}`)
          .replace(/^updated:.*$/m, "updated:"),
      );
      expectedIds.add(blankUpdated.id);

      const indented = await writeFixture(storage, "indented keys parse on both paths", (raw) =>
        raw
          .replace(/^created:/m, "  created:")
          .replace(/^updated:/m, "  updated:"),
      );
      expectedIds.add(indented.id);

      const mtimeAbsent = await writeFixture(storage, "mtime fallback with absent timestamps", (raw) =>
        raw.replace(/^created:.*\n/m, "").replace(/^updated:.*\n/m, ""),
      );
      await utimes(mtimeAbsent.filePath, INCLUDED, INCLUDED);
      expectedIds.add(mtimeAbsent.id);

      const mtimeInvalid = await writeFixture(storage, "mtime fallback with invalid timestamps", (raw) =>
        raw
          .replace(/^created:.*$/m, "created: not-a-timestamp")
          .replace(/^updated:.*$/m, "updated: not-a-timestamp"),
      );
      await utimes(mtimeInvalid.filePath, INCLUDED, INCLUDED);
      expectedIds.add(mtimeInvalid.id);

      return { dir, storage, updatedAfter: UPDATED_AFTER, expectedIds, excludedIds };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: WindowedMemoryState, row: MatrixRow): Promise<void> {
    if (row.dimensions.restart) {
      state.storage = new StorageManager(state.dir, undefined, true);
      await state.storage.ensureDirectories();
    }
    await readColdThenWarm(state);

    if (row.id === "session-end") {
      await state.storage.writeMemory("fact", "write after the first window read");
      state.afterWrite = await state.storage.readMemoriesWindow({ updatedAfter: state.updatedAfter });
    }
  },

  async invariants(state: WindowedMemoryState, row: MatrixRow): Promise<void> {
    assert.ok(state.cold, `${row.id}: cold window result must exist`);
    assert.ok(state.warm, `${row.id}: warm window result must exist`);
    assert.deepEqual(
      state.warm!.filePaths,
      state.cold!.filePaths,
      `${row.id}: warm and cold path selection/order must match`,
    );
    assert.deepEqual(
      state.warm!.memories.map((memory) => memory.path),
      state.cold!.memories.map((memory) => memory.path),
      `${row.id}: warm and cold memory selection/order must match`,
    );

    const selectedIds = new Set(state.cold!.memories.map((memory) => memory.frontmatter.id));
    for (const id of state.expectedIds) assert.ok(selectedIds.has(id), `${row.id}: expected fixture ${id} was selected`);
    for (const id of state.excludedIds) assert.ok(!selectedIds.has(id), `${row.id}: pre-boundary fixture ${id} was excluded`);

    if (row.id === "session-end") {
      assert.ok(state.afterWrite, "cache invalidation row must perform a read after writing");
      assert.equal(
        state.afterWrite!.memories.some((memory) => memory.content.includes("write after the first window read")),
        true,
        "a write between reads must invalidate the window cache and expose the new memory",
      );
    }
  },

  async teardown(state: WindowedMemoryState): Promise<void> {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("windowed-memory-read", subject);
