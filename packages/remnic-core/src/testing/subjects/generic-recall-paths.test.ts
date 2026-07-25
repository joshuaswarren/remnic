import assert from "node:assert/strict";

import { Orchestrator } from "../../orchestrator.js";
import type { SearchBackend } from "../../search/port.js";
import type { MemoryFile, QmdSearchResult } from "../../types.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  mkTempMemoryDir,
} from "../orchestrator-lite.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface QmdSeam {
  qmd: SearchBackend;
}

interface GenericRecallPathState {
  readonly memoryDir: string;
  readonly orchestrator: Orchestrator;
  readonly archivePath: string;
  readonly activePath: string;
  readonly candidates: QmdSearchResult[];
  recalled?: string;
}

function result(memory: MemoryFile, score: number): QmdSearchResult {
  return {
    docid: memory.frontmatter.id,
    path: memory.path,
    score,
    snippet: memory.content,
  };
}

const subject: LifecycleSubject<GenericRecallPathState> = {
  async setup(row: MatrixRow): Promise<GenericRecallPathState> {
    const memoryDir = await mkTempMemoryDir(`generic-recall-${row.id}`);
    let orchestrator: Orchestrator | undefined;
    try {
      orchestrator = new Orchestrator(
        makeLifecycleConfig(memoryDir, {
          qmdEnabled: true,
          qmdSearchStrategy: "lex",
        }),
      );
      const storage = await orchestrator.getStorage();
      const archivedWrite = await storage.writeMemory(
        "fact",
        `archived candidate for ${row.id}`,
      );
      const archivedMemory = await storage.getMemoryById(archivedWrite.id);
      assert.ok(archivedMemory);
      const archivePath = await storage.archiveMemory(archivedMemory);
      assert.ok(archivePath);

      const activeWrite = await storage.writeMemory(
        "fact",
        `active candidate for ${row.id}`,
      );
      const activeMemory = await storage.getMemoryById(activeWrite.id);
      assert.ok(activeMemory);
      const candidates = [
        result({ ...archivedMemory, path: archivePath }, 1),
        result(activeMemory, 0.9),
      ];
      const seam = orchestrator as unknown as QmdSeam;
      seam.qmd = {
        isAvailable: () => true,
        debugStatus: () => "lifecycle-test-qmd",
        search: async () => candidates,
        hybridSearch: async () => candidates,
      } as unknown as SearchBackend;
      return {
        memoryDir,
        orchestrator,
        archivePath,
        activePath: activeMemory.path,
        candidates,
      };
    } catch (error) {
      await orchestrator?.destroy().catch(() => undefined);
      await cleanupDir(memoryDir);
      throw error;
    }
  },

  async exercise(state): Promise<void> {
    state.recalled = await state.orchestrator.recall(
      "candidate",
      undefined,
      { recallMode: "full" },
    );
  },

  async invariants(state): Promise<void> {
    assert.match(state.recalled ?? "", /active candidate/);
    assert.doesNotMatch(state.recalled ?? "", /archived candidate/);
    assert.equal(
      state.candidates[0]?.path,
      state.archivePath,
      "the QMD fixture must put the archived memory ahead of the active hit",
    );
    assert.equal(
      state.candidates[1]?.path,
      state.activePath,
      "the QMD fixture must include the persisted active memory",
    );
  },

  async teardown(state): Promise<void> {
    await state.orchestrator.destroy();
    await cleanupDir(state.memoryDir);
  },
};

runLifecycleMatrix("generic-recall-paths", subject);
