import assert from "node:assert/strict";

import { Orchestrator } from "../../orchestrator.js";
import type { SearchBackend } from "../../search/port.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../../types.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  mkTempMemoryDir,
  singleFactResult,
  stubExtraction,
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
  orchestrator: Orchestrator;
  readonly config: PluginConfig;
  readonly archivePath: string;
  readonly activePath: string;
  readonly candidates: QmdSearchResult[];
  recalled?: string;
}

function installQmd(orchestrator: Orchestrator, candidates: QmdSearchResult[]): void {
  const seam = orchestrator as unknown as QmdSeam;
  seam.qmd = {
    isAvailable: () => true,
    debugStatus: () => "lifecycle-test-qmd",
    search: async () => candidates,
    hybridSearch: async () => candidates,
  } as unknown as SearchBackend;
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
      const config = makeLifecycleConfig(memoryDir, {
        qmdEnabled: true,
        qmdSearchStrategy: "lex",
      });
      orchestrator = new Orchestrator(config);
      stubExtraction(orchestrator, () => singleFactResult(`replay-${row.id}`));
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
      installQmd(orchestrator, candidates);
      return {
        memoryDir,
        orchestrator,
        config,
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

  async exercise(state, row): Promise<void> {
    const sessionKey = `generic-recall-${row.id}`;
    if (row.dimensions.flush !== "none") {
      await state.orchestrator.flushSession(sessionKey, {
        reason: row.dimensions.flush,
      });
    }
    if (row.dimensions.restart) {
      await state.orchestrator.destroy();
      state.orchestrator = new Orchestrator(state.config);
      installQmd(state.orchestrator, state.candidates);
    }
    if (
      row.dimensions.providerIdentity === "explicit" ||
      (row.dimensions.providerIdentity === "sparse" && row.dimensions.rememberedBinding)
    ) {
      state.orchestrator.setPeerIdForSession(sessionKey, "remembered-provider");
    } else if (row.dimensions.providerIdentity === "rebound") {
      state.orchestrator.setPeerIdForSession(sessionKey, "provider-a");
      state.orchestrator.setPeerIdForSession(sessionKey, "provider-b");
    }
    if (row.dimensions.dedupeOrReplay) {
      const replayTurn = {
        source: "openclaw" as const,
        sessionKey,
        role: "user" as const,
        content: "replayed candidate",
        timestamp: "2026-07-25T00:00:00.000Z",
      };
      await state.orchestrator.ingestReplayBatch(
        [replayTurn, { ...replayTurn }],
        { archiveLcm: false },
      );
    }
    state.recalled = await state.orchestrator.recall("candidate", sessionKey);
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
