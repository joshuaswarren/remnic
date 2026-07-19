/**
 * recall-cold-deadline.test.ts — issue #1907.
 *
 * Pins the task-level cancellation contract of runColdStepWithinDeadline
 * inside RecallSearchPipelineCoordinator.applyColdFallbackPipeline:
 *   - when the per-step deadline wins, the losing cold task's INJECTED signal
 *     is aborted (so an orphaned archive scan stops cooperatively) and the
 *     step returns its fallback (fail-open);
 *   - a task-level deadline must NOT abort the request-level signal;
 *   - a task that completes normally (no deadline) never aborts the injected
 *     step signal.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  RecallSearchPipelineCoordinator,
  type RecallSearchPipelineDeps,
} from "./orchestration/recall-search-pipeline.js";
import type { PluginConfig, QmdSearchResult, RecallPlanMode } from "./types.js";

async function coldConfig() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1907-cold-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    namespacesEnabled: false,
  });
  return { memoryDir, config };
}

/**
 * Minimal deps for the archive-scan branch. qmd.isAvailable() === false forces
 * the cold-qmd block to be skipped, so control reaches the archive-scan step;
 * an empty archive result returns [] before any namespace/storage-router work,
 * keeping the stub surface tight. The cast is a deliberate test double.
 */
function coldDeps(
  config: PluginConfig,
  searchLongTermArchiveFallback: RecallSearchPipelineDeps["searchLongTermArchiveFallback"],
): RecallSearchPipelineDeps {
  return {
    config,
    qmd: { isAvailable: () => false },
    namespaceFromPath: () => "default",
    searchLongTermArchiveFallback,
  } as unknown as RecallSearchPipelineDeps;
}

test("#1907: cold archive-scan deadline aborts the injected step signal, returns fallback, leaves the request signal intact", async () => {
  const { memoryDir, config } = await coldConfig();
  try {
    const stuck = Promise.withResolvers<QmdSearchResult[]>();
    let capturedStepSignal: AbortSignal | undefined;
    // Observable side-effect channel. A cooperatively-cancelled worker sees
    // stepSignal.aborted === true by the time it settles late and performs no
    // write; if the deadline's abort wiring is removed the signal never aborts,
    // so the late completion leaks "late" here and the assertion below fails.
    const lateWrites: string[] = [];
    const abandonedTaskSettled = Promise.withResolvers<void>();
    const deps = coldDeps(config, async (_prompt, _ns, _limit, _prefilter, abortSignal) => {
      capturedStepSignal = abortSignal;
      const late = await stuck.promise; // does not settle before the deadline wins
      if (!abortSignal?.aborted) {
        for (const hit of late) lateWrites.push(hit.docid);
      }
      abandonedTaskSettled.resolve();
      return late;
    });
    const coordinator = new RecallSearchPipelineCoordinator(deps);

    const requestController = new AbortController();
    const result = await coordinator.applyColdFallbackPipeline({
      prompt: "long term recall",
      recallNamespaces: ["default"],
      recallResultLimit: 5,
      recallMode: "full" as RecallPlanMode,
      deadlineAtMs: Date.now() + 120,
      abortSignal: requestController.signal,
    });

    assert.deepEqual(result, [], "the step returns its fallback when the deadline wins");
    assert.ok(capturedStepSignal, "archive scan received an injected step signal");
    assert.equal(
      capturedStepSignal!.aborted,
      true,
      "the injected step signal is aborted on deadline so the losing task stops",
    );
    assert.equal(
      requestController.signal.aborted,
      false,
      "a task-level deadline must NOT abort the request-level signal",
    );

    // The abandoned task's LATE completion has no observable side effect: a
    // cooperative worker sees its injected signal aborted and performs no write.
    // Deterministic — we await the abandoned task's own settlement, not a bare
    // microtask flush.
    stuck.resolve([{ docid: "late", path: "/facts/late.md", snippet: "late", score: 1 }]);
    await abandonedTaskSettled.promise;
    assert.deepEqual(
      lateWrites,
      [],
      "the abandoned task observed its abort and performed no late write",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#1907: a cold step that completes before its deadline never aborts the injected step signal", async () => {
  const { memoryDir, config } = await coldConfig();
  try {
    let capturedStepSignal: AbortSignal | undefined;
    const deps = coldDeps(config, async (_prompt, _ns, _limit, _prefilter, abortSignal) => {
      capturedStepSignal = abortSignal;
      return []; // resolves immediately, well within the deadline
    });
    const coordinator = new RecallSearchPipelineCoordinator(deps);

    const requestController = new AbortController();
    const result = await coordinator.applyColdFallbackPipeline({
      prompt: "long term recall",
      recallNamespaces: ["default"],
      recallResultLimit: 5,
      recallMode: "full" as RecallPlanMode,
      deadlineAtMs: Date.now() + 30_000,
      abortSignal: requestController.signal,
    });

    assert.deepEqual(result, [], "empty archive returns []");
    assert.ok(capturedStepSignal, "archive scan received an injected step signal");
    assert.equal(
      capturedStepSignal!.aborted,
      false,
      "normal completion must not abort the injected step signal",
    );
    assert.equal(requestController.signal.aborted, false, "request signal untouched");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
