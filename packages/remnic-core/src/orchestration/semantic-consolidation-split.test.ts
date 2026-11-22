import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import { SemanticConsolidationCoordinator } from "./semantic-consolidation-coordinator.js";

function makeMemory(index: number): MemoryFile {
  const created = `2026-04-${String(10 + index).padStart(2, "0")}T00:00:00Z`;
  return {
    path: `/memory/facts/m${index}.md`,
    frontmatter: {
      id: `m${index}`,
      category: "fact",
      created,
      updated: created,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
    },
    content: "The deploy runs on Fridays and the release notes go to the team channel.",
  };
}

test("a SPLIT response writes one memory per output and archives sources against all of them (#3566)", async () => {
  const memories = Array.from({ length: 10 }, (_, i) => makeMemory(i));
  const written: string[] = [];
  const archived: Array<{ id: string; related: string[] }> = [];
  const fakeStorage = {
    dir: "/memory",
    readAllMemories: async () => memories,
    snapshotForProvenance: async () => null,
    writeSealedMemory: async (envelope: { content: string }) => {
      written.push(envelope.content);
      return { id: `canonical-${written.length}`, tombstoneBlocked: false };
    },
    archiveMemory: async (memory: MemoryFile, lifecycle?: { relatedMemoryIds?: string[] }) => {
      archived.push({ id: memory.frontmatter.id, related: lifecycle?.relatedMemoryIds ?? [] });
      return `/memory/archive/${memory.frontmatter.id}.md`;
    },
  };
  const fakeFastLlm = {
    chatCompletion: async () => ({
      content: JSON.stringify({
        operator: "split",
        outputs: ["The deploy runs on Fridays.", "Release notes go to the team channel."],
      }),
    }),
  };
  const coordinator = new SemanticConsolidationCoordinator({
    config: parseConfig({ operatorAwareConsolidationEnabled: true, semanticConsolidationModel: "fast" }),
    // SAFETY: the coordinator only calls the five members the fake defines on this path.
    getStorage: (): StorageManager => fakeStorage as never,
    // SAFETY: the fast-LLM path only calls chatCompletion.
    getFastLlm: (): LocalLlmClient => fakeFastLlm as never,
    // SAFETY: archival only calls removeFromIndex.
    embeddingFallback: { removeFromIndex: async () => {} } as never,
    removeContentHashForMemory: async () => {},
    saveContentHashIndexes: async () => {},
  });

  const result = await coordinator.runSemanticConsolidation({ force: true });

  assert.ok(result.clustersFound >= 1, `expected a cluster, got ${result.clustersFound}`);
  assert.equal(result.errors, 0);
  assert.deepEqual(written, ["The deploy runs on Fridays.", "Release notes go to the team channel."]);
  assert.ok(archived.length > 0);
  for (const entry of archived) assert.deepEqual(entry.related, ["canonical-1", "canonical-2"]);
});
