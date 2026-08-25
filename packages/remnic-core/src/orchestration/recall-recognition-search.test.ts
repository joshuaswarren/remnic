/**
 * recall-recognition-search.test.ts — issue #2975 recall-slice wiring.
 *
 * Pins the fetchQmdMemoryResultsWithArtifactTopUp seam:
 *  - gate off: original fetch only (zero extra I/O, same options object);
 *  - under-threshold index: recognition pass, no vector fetch for that ns;
 *  - above-threshold index: vector fetch, no recognizer call.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { saveRecognitionIndex, type RecognitionIndex } from "../recall-recognition-tier.js";
import {
  fetchQmdMemoryResultsWithRecognitionSwap,
  type RecognitionSearchDeps,
} from "./recall-recognition-search.js";
import type { QmdSearchResult } from "../types.js";

function vec(namespace: string, filePath: string, score = 1): QmdSearchResult {
  return { docid: `${namespace}:${filePath}`, namespace, path: filePath, score, snippet: filePath };
}

function indexOf(ids: string[]): RecognitionIndex {
  return {
    version: 1,
    entries: ids.map((id) => ({ id, description: `trigger for ${id}` })),
  };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-recognition-search-"));
}

function makeDeps(args: {
  recallRecognitionTier: boolean;
  recognitionIndexMaxEntries?: number;
  storages: Record<string, { dir: string; pathsById: Record<string, string> }>;
  vectorResults?: QmdSearchResult[];
  recognize?: (prompt: string) => Promise<string>;
  recognizeError?: Error;
}) {
  const fetchCalls: Array<{
    prompt: string;
    qmdFetchLimit: number;
    qmdHybridFetchLimit: number;
    options: unknown;
  }> = [];
  const recognizePrompts: string[] = [];
  const storageForCalls: string[] = [];

  const deps = {
    config: {
      recallRecognitionTier: args.recallRecognitionTier,
      recognitionIndexMaxEntries: args.recognitionIndexMaxEntries ?? 500,
    },
    storageRouter: {
      storageFor: async (namespace: string) => {
        storageForCalls.push(namespace);
        const storage = args.storages[namespace];
        if (!storage) throw new Error(`unknown namespace ${namespace}`);
        return {
          dir: storage.dir,
          findExistingMemoryPaths: async (ids: string[]) => {
            const found = new Map<string, string[]>();
            for (const id of ids) {
              const filePath = storage.pathsById[id];
              if (filePath) found.set(id, [filePath]);
            }
            return found;
          },
        };
      },
    },
    fastLlmForRerank: {
      chatCompletion: async (messages: Array<{ role: string; content: string }>) => {
        if (args.recognizeError) throw args.recognizeError;
        const prompt = messages[0]?.content ?? "";
        recognizePrompts.push(prompt);
        return { content: await (args.recognize ?? (async () => ""))(prompt) };
      },
    },
    fetchQmdMemoryResultsWithArtifactTopUp: async (
      prompt: string,
      qmdFetchLimit: number,
      qmdHybridFetchLimit: number,
      options: unknown,
    ) => {
      fetchCalls.push({ prompt, qmdFetchLimit, qmdHybridFetchLimit, options });
      return args.vectorResults ?? [];
    },
  } as unknown as RecognitionSearchDeps;

  return { deps, fetchCalls, recognizePrompts, storageForCalls };
}

const baseOptions = {
  namespacesEnabled: true,
  recallNamespaces: ["alpha"],
  resolveNamespace: (filePath: string) => (filePath.startsWith("beta/") ? "beta" : "alpha"),
};

test("off-path: gate off calls original fetch once with the same options object", async () => {
  const options = { ...baseOptions };
  const { deps, fetchCalls, recognizePrompts, storageForCalls } = makeDeps({
    recallRecognitionTier: false,
    storages: {},
    vectorResults: [vec("alpha", "facts/from-vector.md")],
  });

  const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 7, 9, options);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].prompt, "q");
  assert.equal(fetchCalls[0].qmdFetchLimit, 7);
  assert.equal(fetchCalls[0].qmdHybridFetchLimit, 9);
  assert.equal(fetchCalls[0].options, options);
  assert.equal(recognizePrompts.length, 0);
  assert.equal(storageForCalls.length, 0);
  assert.deepEqual(out.map((r) => r.path), ["facts/from-vector.md"]);
});

test("acceptance: under-threshold namespace uses recognition, not vector search", async () => {
  const dir = await tmpDir();
  try {
    await saveRecognitionIndex(dir, indexOf(["m-001", "m-002", "m-003"]));
    const { deps, fetchCalls, recognizePrompts } = makeDeps({
      recallRecognitionTier: true,
      recognitionIndexMaxEntries: 10,
      storages: {
        alpha: {
          dir,
          pathsById: {
            "m-001": path.join(dir, "facts/m-001.md"),
            "m-002": path.join(dir, "facts/m-002.md"),
            "m-003": path.join(dir, "facts/m-003.md"),
          },
        },
      },
      recognize: async () => "m-002, m-003",
      vectorResults: [vec("alpha", "facts/must-not-appear.md")],
    });

    const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "which memories?", 5, 5, {
      ...baseOptions,
    });

    assert.equal(fetchCalls.length, 0, "vector search must not run on the recognition tier");
    assert.equal(recognizePrompts.length, 1);
    assert.ok(recognizePrompts[0].includes("m-001: trigger for m-001"));
    assert.ok(recognizePrompts[0].includes("m-002: trigger for m-002"));
    assert.ok(recognizePrompts[0].includes("m-003: trigger for m-003"));
    assert.deepEqual(
      out.map((r) => r.path),
      ["facts/m-002.md", "facts/m-003.md"],
    );
    assert.deepEqual(
      out.map((r) => r.namespace),
      ["alpha", "alpha"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance: above-threshold namespace uses vector search, not the recognizer", async () => {
  const dir = await tmpDir();
  try {
    await saveRecognitionIndex(dir, indexOf(["a", "b", "c", "d", "e"]));
    const options = { ...baseOptions };
    const { deps, fetchCalls, recognizePrompts } = makeDeps({
      recallRecognitionTier: true,
      recognitionIndexMaxEntries: 4,
      storages: { alpha: { dir, pathsById: {} } },
      vectorResults: [vec("alpha", "facts/vector-hit.md")],
    });

    const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 3, 3, options);

    assert.equal(recognizePrompts.length, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options, options);
    assert.deepEqual(out.map((r) => r.path), ["facts/vector-hit.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance: missing index falls back to vector search with original options", async () => {
  const dir = await tmpDir();
  try {
    const options = { ...baseOptions };
    const { deps, fetchCalls, recognizePrompts } = makeDeps({
      recallRecognitionTier: true,
      storages: { alpha: { dir, pathsById: {} } },
      vectorResults: [vec("alpha", "facts/fallback.md")],
    });

    const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 2, 2, options);

    assert.equal(recognizePrompts.length, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options, options);
    assert.deepEqual(out.map((r) => r.path), ["facts/fallback.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixed namespaces: small ns recognizes; large ns stays on vector search", async () => {
  const small = await tmpDir();
  const large = await tmpDir();
  try {
    await saveRecognitionIndex(small, indexOf(["s-1", "s-2"]));
    await saveRecognitionIndex(large, indexOf(["l-1", "l-2", "l-3"]));
    const { deps, fetchCalls, recognizePrompts } = makeDeps({
      recallRecognitionTier: true,
      recognitionIndexMaxEntries: 2,
      storages: {
        alpha: {
          dir: small,
          pathsById: { "s-1": path.join(small, "facts/s-1.md") },
        },
        beta: { dir: large, pathsById: {} },
      },
      recognize: async () => "s-1",
      vectorResults: [vec("beta", "facts/large-hit.md")],
    });

    const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 10, 10, {
      namespacesEnabled: true,
      recallNamespaces: ["alpha", "beta"],
      resolveNamespace: (filePath) => (filePath.includes("large") ? "beta" : "alpha"),
    });

    assert.equal(recognizePrompts.length, 1);
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(
      (fetchCalls[0].options as { recallNamespaces: string[] }).recallNamespaces,
      ["beta"],
    );
    assert.deepEqual(
      out.map((r) => `${r.namespace}:${r.path}`),
      ["alpha:facts/s-1.md", "beta:facts/large-hit.md"],
    );
  } finally {
    await rm(small, { recursive: true, force: true });
    await rm(large, { recursive: true, force: true });
  }
});

test("loud degradation: recognizer throw routes that namespace back to vector search", async () => {
  const dir = await tmpDir();
  try {
    await saveRecognitionIndex(dir, indexOf(["m-001"]));
    const { deps, fetchCalls, recognizePrompts } = makeDeps({
      recallRecognitionTier: true,
      storages: { alpha: { dir, pathsById: { "m-001": path.join(dir, "facts/m-001.md") } } },
      recognizeError: new Error("model down"),
      vectorResults: [vec("alpha", "facts/degraded.md")],
    });

    const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 4, 4, { ...baseOptions });

    assert.equal(recognizePrompts.length, 0);
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(out.map((r) => r.path), ["facts/degraded.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("namespaces disabled: gate on still calls original fetch with the same options object", async () => {
  const options = { ...baseOptions, namespacesEnabled: false };
  const { deps, fetchCalls, recognizePrompts, storageForCalls } = makeDeps({
    recallRecognitionTier: true,
    storages: {},
    vectorResults: [vec("alpha", "facts/from-vector.md")],
  });

  const out = await fetchQmdMemoryResultsWithRecognitionSwap(deps, "q", 2, 2, options);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options, options);
  assert.equal(recognizePrompts.length, 0);
  assert.equal(storageForCalls.length, 0);
  assert.deepEqual(out.map((r) => r.path), ["facts/from-vector.md"]);
});
