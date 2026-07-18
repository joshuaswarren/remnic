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
    const deps = coldDeps(config, async (_prompt, _ns, _limit, _prefilter, abortSignal) => {
      capturedStepSignal = abortSignal;
      return stuck.promise; // never resolves — the deadline must win the race
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

    // A late resolution of the abandoned task cannot change the already-returned
    // fallback — no late side effect on the recall result.
    stuck.resolve([{ docid: "late", path: "/facts/late.md", snippet: "late", score: 1 }]);
    await Promise.resolve();
    assert.deepEqual(result, [], "the fallback is unaffected by the abandoned task settling late");
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
