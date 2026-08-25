/**
 * Recognition-tier swap subject for the scenario-matrix harness (issue #2975).
 *
 * Every canonical row runs the real fetchQmdMemoryResultsWithRecognitionSwap
 * seam twice: gate off (original fetch only, zero index I/O, zero recognizer
 * calls) and gate on with an under-threshold index (one recognizer call, the
 * namespace never reaches vector search). The scenario dimensions are
 * orthogonal to this routing decision, so the same invariant holds per row.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  fetchQmdMemoryResultsWithRecognitionSwap,
  type RecognitionSearchDeps,
} from "../../orchestration/recall-recognition-search.js";
import { saveRecognitionIndex } from "../../recall-recognition-tier.js";
import type { QmdSearchResult } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
interface SwapState {
  rowId: string;
  dir: string;
  deps: (enabled: boolean) => RecognitionSearchDeps;
  fetchCalls: number;
  recognizeCalls: number;
  storageForCalls: number;
}

const subject: LifecycleSubject<SwapState> = {
  async setup(row: MatrixRow): Promise<SwapState> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-recognition-subject-"));
    await saveRecognitionIndex(dir, {
      version: 1,
      entries: [
        { id: `m-${row.id}-a`, description: `trigger for ${row.id}-a` },
        { id: `m-${row.id}-b`, description: `trigger for ${row.id}-b` },
      ],
    });
    const state: SwapState = { rowId: String(row.id), dir, deps: undefined as never, fetchCalls: 0, recognizeCalls: 0, storageForCalls: 0 };
    state.deps = (enabled) =>
      ({
        config: { recallRecognitionTier: enabled, recognitionIndexMaxEntries: 500 },
        storageRouter: {
          storageFor: async () => {
            state.storageForCalls += 1;
            return {
              dir,
              findExistingMemoryPaths: async (ids: string[]) =>
                new Map(ids.map((id) => [id, [path.join(dir, `facts/${id}.md`)]])),
            };
          },
        },
        fastLlmForRerank: {
          chatCompletion: async () => {
            state.recognizeCalls += 1;
            return { content: JSON.stringify([`m-${row.id}-a`, `m-${row.id}-b`]) };
          },
        },
        fetchQmdMemoryResultsWithArtifactTopUp: async (): Promise<QmdSearchResult[]> => {
          state.fetchCalls += 1;
          return [{ docid: `default:vector.md`, namespace: "default", path: "vector.md", score: 1, snippet: "vector" }];
        },
      }) as unknown as RecognitionSearchDeps;
    return state;
  },

  async exercise(state): Promise<void> {
    const options = {
      namespacesEnabled: true,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
    };

    const off = await fetchQmdMemoryResultsWithRecognitionSwap(state.deps(false), "q", 5, 7, options);
    assert.equal(off.length, 1);
    assert.equal(state.fetchCalls, 1);
    assert.equal(state.recognizeCalls, 0);
    assert.equal(state.storageForCalls, 0);

    const on = await fetchQmdMemoryResultsWithRecognitionSwap(state.deps(true), "q", 5, 7, options);
    assert.equal(state.recognizeCalls, 1);
    assert.equal(state.fetchCalls, 1, "recognition namespace must not reach vector fetch");
    assert.deepEqual(on.map((r) => r.path).sort(), [`facts/m-${state.rowId}-a.md`, `facts/m-${state.rowId}-b.md`].sort());
  },

  async invariants(state): Promise<void> {
    // Off-path again after the on-path run: still a pure passthrough.
    const before = { fetch: state.fetchCalls, recognize: state.recognizeCalls, storage: state.storageForCalls };
    await fetchQmdMemoryResultsWithRecognitionSwap(state.deps(false), "q", 5, 7, {
      namespacesEnabled: true,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
    });
    assert.equal(state.fetchCalls, before.fetch + 1);
    assert.equal(state.recognizeCalls, before.recognize);
    assert.equal(state.storageForCalls, before.storage);
  },

  async teardown(state): Promise<void> {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("recall-recognition-tier", subject);
