// Bounded-shutdown behavioral test: a daemon stop must finish even while an
// extraction is parked on a never-settling LLM call, because the
// orchestrator-owned shutdown abort signal reaches the extraction call and
// the extraction queue drain. The aborted extraction must leave its
// buffered turns in place (persisted on disk, nothing extracted).
//
// Uses the established characterization seams: field-level extraction stub
// (orchestrator.extraction) and the REAL teardown chain
// (shutdownBacklogDrain with the real orchestrator.destroy) exactly as the
// server stop path wires it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Orchestrator } from "@remnic/core/orchestrator";
import { parseConfig } from "@remnic/core/config";
import type { BufferTurn, ExtractionResult, PluginConfig } from "@remnic/core/types";
import { initLogger } from "@remnic/core";
import { resetLogger } from "@remnic/core/logger";
import { shutdownBacklogDrain } from "../packages/remnic-server/src/backlog-drain-lifecycle.js";

function makeConfig(memoryDir: string): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    initGateTimeoutMs: 1000,
  });
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label}: test deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(
  probe: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("stop completes while extraction is parked on a never-settling LLM; the shutdown abort reached the stub and the buffered turn survived", async () => {
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false);
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-shutdown-abort-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  let stubSignal: AbortSignal | undefined;
  // SAFETY: extraction is stubbed at the established field seam (same as
  // orchestrator-characterization.test.ts); the field is private to the
  // orchestrator. The stub parks forever unless the shutdown abort arrives.
  (orchestrator as any).extraction = {
    extract: async (
      turns: BufferTurn[],
      existingEntities: string[],
      signal?: AbortSignal,
    ): Promise<ExtractionResult> => {
      void existingEntities;
      stubSignal = signal;
      await new Promise<never>(() => { /* never settles: wedged local LLM */ });
      return { facts: [], entities: [], relationships: [], questions: [], profileUpdates: [] };
    },
  };

  try {
    // "Please remember" is a built-in high-signal pattern: the turn goes
    // straight to extract_now, so extraction is IN FLIGHT (not queued) when
    // the stop chain starts.
    await orchestrator.processTurn(
      "user",
      "Please remember: the bounded shutdown drill report lives in the ops binder.",
      "sess-shutdown-abort",
    );
    await eventually(() => stubSignal !== undefined, "extraction to start and reach the stub");

    // The real stop chain, exactly as index.ts wires it: scheduler abort,
    // then orchestrator.destroy, then finish.
    let finishRan = false;
    await withTestDeadline(
      shutdownBacklogDrain(
        undefined,
        () => orchestrator.destroy(),
        () => {
          finishRan = true;
        },
      ),
      10_000,
      "stop chain with wedged extraction",
    );
    assert.equal(finishRan, true, "finish must run even when the drain was aborted");

    // The shutdown abort must have reached the extraction stub.
    assert.equal(stubSignal?.aborted, true, "the shutdown abort signal must reach the extraction stub");

    // The aborted extraction leaves its buffered turn in place: still on
    // disk (persisted by the pre-drain flush), never extracted. Session-
    // capable storage writes per-session files under state/, legacy writes
    // state/buffer.json — assert on the persisted content, not the layout.
    const stateDir = path.join(memoryDir, "state");
    // SAFETY: recursive readdir without an encoding yields names only.
    const stateFiles = (await readdir(stateDir, { recursive: true })) as string[];
    const persistedJsonFiles = stateFiles.filter((entry) => entry.endsWith(".json"));
    assert.ok(persistedJsonFiles.length > 0, "the pre-drain flush must persist buffer state under state/");
    const persistedRaw = await Promise.all(
      persistedJsonFiles.map((entry) => readFile(path.join(stateDir, entry), "utf-8")),
    );
    assert.ok(
      persistedRaw.some((raw) => raw.includes("bounded shutdown drill report")),
      "the buffered turn must survive the aborted extraction",
    );

    const factsDir = path.join(memoryDir, "facts");
    let factFiles = 0;
    try {
      // SAFETY: recursive readdir without an encoding yields names only.
      const entries = (await readdir(factsDir, { recursive: true })) as string[];
      factFiles = entries.filter((entry) => entry.endsWith(".md")).length;
    } catch (err) {
      // SAFETY: fs errors surface as NodeJS.ErrnoException with a code.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    assert.equal(factFiles, 0, "an aborted extraction must not persist extracted memories");
  } finally {
    resetLogger();
    await cleanupDir(memoryDir);
  }
});

test("an extraction already inside its persist stage when destroy() starts still completes: the delivery getter must not throw mid-drain", async () => {
  initLogger({ info() {}, warn() {}, error() {} }, false);
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-shutdown-persist-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  try {
    // In any real session the delivery already exists before SIGTERM; the
    // persist stage reads the getter again while destroy() awaits the drain.
    // SAFETY: dependencyPropagationDelivery is a private orchestrator getter,
    // read at the established field seam (same as the wedged-extraction test above).
    const delivery = (orchestrator as any).dependencyPropagationDelivery;
    assert.ok(delivery, "the delivery getter must be reachable before destroy");
    // SAFETY: extractionQueueCoordinator is a private orchestrator field; the
    // stub implements the two members destroy() calls on it.
    (orchestrator as any).extractionQueueCoordinator = {
      stopAccepting(): void {},
      async pauseAndDrain(): Promise<boolean> {
        // SAFETY: same private getter as above. ExtractionPersistCoordinator
        // reads it while the queue drain is in flight; this read is that path.
        void (orchestrator as any).dependencyPropagationDelivery;
        return true;
      },
    };

    await withTestDeadline(
      orchestrator.destroy(),
      10_000,
      "destroy with a persist-stage delivery read",
    );
  } finally {
    resetLogger();
    await cleanupDir(memoryDir);
  }
});
