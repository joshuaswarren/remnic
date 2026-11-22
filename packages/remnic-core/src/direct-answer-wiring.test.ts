import assert from "node:assert/strict";
import test from "node:test";

import {
  tryDirectAnswer,
  type DirectAnswerSources,
  type DirectAnswerWiringInput,
} from "./direct-answer-wiring.js";
import { DEFAULT_TAXONOMY } from "./taxonomy/default-taxonomy.js";
import type { MemoryFile } from "./types.js";
import type { TrustZoneName } from "./trust-zones.js";

type WiringConfig = DirectAnswerWiringInput["config"];

const BASE_CONFIG: WiringConfig = {
  recallDirectAnswerTokenOverlapFloor: 0.5,
  recallDirectAnswerImportanceFloor: 0.7,
  recallDirectAnswerAmbiguityMargin: 0.15,
  recallDirectAnswerEligibleTaxonomyBuckets: [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ],
};

function makeMemory(overrides: {
  id?: string;
  category?: MemoryFile["frontmatter"]["category"];
  tags?: string[];
  content?: string;
  status?: MemoryFile["frontmatter"]["status"];
  verificationState?: MemoryFile["frontmatter"]["verificationState"];
  entityRef?: string;
} = {}): MemoryFile {
  const id = overrides.id ?? "m1";
  return {
    path: `/memory/${id}.md`,
    frontmatter: {
      id,
      category: overrides.category ?? "decision",
      created: "2026-04-19T00:00:00.000Z",
      updated: "2026-04-19T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: overrides.tags ?? [],
      status: overrides.status,
      verificationState: overrides.verificationState,
      entityRef: overrides.entityRef,
    },
    content: overrides.content ?? "",
  };
}

interface MockSources extends DirectAnswerSources {
  calls: {
    listCandidates: number;
    trustZone: string[];
    importance: string[];
  };
}

function makeMockSources(init: {
  memories?: MemoryFile[];
  trustZones?: Record<string, TrustZoneName | null>;
  importance?: Record<string, number>;
} = {}): MockSources {
  const calls = { listCandidates: 0, trustZone: [] as string[], importance: [] as string[] };
  return {
    calls,
    taxonomy: DEFAULT_TAXONOMY,
    listCandidateMemories: async () => {
      calls.listCandidates += 1;
      return init.memories ?? [];
    },
    trustZoneFor: async (id: string) => {
      calls.trustZone.push(id);
      return init.trustZones?.[id] ?? null;
    },
    importanceFor: (memory: MemoryFile) => {
      calls.importance.push(memory.frontmatter.id);
      return init.importance?.[memory.frontmatter.id] ?? 0;
    },
  };
}


test("tryDirectAnswer disabled-path does not call any source accessor", async () => {
  const sources = makeMockSources({ memories: [makeMemory()] });
  const result = await tryDirectAnswer({
    query: "does not matter",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: false,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "disabled");
  assert.equal(sources.calls.listCandidates, 0);
  assert.deepEqual(sources.calls.trustZone, []);
  assert.deepEqual(sources.calls.importance, []);
});


test("tryDirectAnswer disabled when `enabled: false` even with matching candidates (caps wins over any config-derived value)", async () => {
  const sources = makeMockSources({
    memories: [makeMemory({ tags: ["pnpm"], content: "remnic uses pnpm" })],
    trustZones: { m1: "trusted" },
    importance: { m1: 0.9 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: false,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "disabled");
  assert.equal(sources.calls.listCandidates, 0);
});

test("tryDirectAnswer proceeds when `enabled: true` and candidates match", async () => {
  const sources = makeMockSources({
    memories: [makeMemory({ tags: ["pnpm"], content: "remnic uses pnpm" })],
    trustZones: { m1: "trusted" },
    importance: { m1: 0.9 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.notEqual(result.reason, "disabled");
  assert.equal(sources.calls.listCandidates, 1);
});


test("tryDirectAnswer skips all I/O when query normalizes to zero searchable tokens", async () => {
  const sources = makeMockSources({
    memories: [makeMemory({ tags: ["pnpm"], content: "remnic uses pnpm" })],
    trustZones: { m1: "trusted" },
    importance: { m1: 0.9 },
  });
  const result = await tryDirectAnswer({
    query: "? !!!  ",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.reason, "empty-query");
  assert.equal(sources.calls.listCandidates, 0);
  assert.deepEqual(sources.calls.trustZone, []);
  assert.deepEqual(sources.calls.importance, []);
});


test("tryDirectAnswer with empty memory list returns no-candidates", async () => {
  const sources = makeMockSources({ memories: [] });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.reason, "no-candidates");
  assert.equal(sources.calls.listCandidates, 1);
});


test("tryDirectAnswer skips importance resolution for non-trusted memories", async () => {
  const memory = makeMemory({
    id: "working-zone",
    tags: ["pnpm"],
    content: "remnic uses pnpm",
  });
  const sources = makeMockSources({
    memories: [memory],
    trustZones: { "working-zone": "working" },
    importance: { "working-zone": 0.99 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "no-candidates");
  assert.deepEqual(sources.calls.importance, []);
});

test("tryDirectAnswer skips importance for quarantine-zone memories", async () => {
  const memory = makeMemory({
    id: "quarantined",
    tags: ["pnpm"],
    content: "remnic uses pnpm",
  });
  const sources = makeMockSources({
    memories: [memory],
    trustZones: { quarantined: "quarantine" },
    importance: { quarantined: 0.99 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(sources.calls.importance, []);
});

test("tryDirectAnswer skips importance when trust zone is missing (null)", async () => {
  const memory = makeMemory({
    id: "no-zone",
    tags: ["pnpm"],
    content: "remnic uses pnpm",
  });
  const sources = makeMockSources({
    memories: [memory],
    trustZones: { "no-zone": null },
    importance: { "no-zone": 0.99 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(sources.calls.importance, []);
});


test("tryDirectAnswer skips importance when taxonomy bucket is not eligible", async () => {
  const memory = makeMemory({
    id: "correction-memory",
    category: "correction",
    tags: ["pnpm"],
    content: "remnic uses pnpm",
  });
  const sources = makeMockSources({
    memories: [memory],
    trustZones: { "correction-memory": "trusted" },
    importance: { "correction-memory": 0.99 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(sources.calls.importance, []);
});


test("tryDirectAnswer returns eligible for a single trusted user-confirmed decision", async () => {
  const memory = makeMemory({
    id: "pm",
    category: "decision",
    verificationState: "user_confirmed",
    tags: ["package-manager", "remnic"],
    content: "remnic uses pnpm as its package manager",
  });
  const sources = makeMockSources({
    memories: [memory],
    trustZones: { pm: "trusted" },
    importance: { pm: 0.8 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.winner?.memory.frontmatter.id, "pm");
  assert.ok(result.narrative.includes("decisions"));
  assert.deepEqual(sources.calls.importance, ["pm"]);
});


test("tryDirectAnswer defers to hybrid when two trusted candidates are within ambiguity margin", async () => {
  const a = makeMemory({
    id: "a",
    tags: ["package-manager", "remnic"],
    content: "remnic uses pnpm",
  });
  const b = makeMemory({
    id: "b",
    tags: ["package-manager", "remnic"],
    content: "remnic uses pnpm as its package manager",
  });
  const sources = makeMockSources({
    memories: [a, b],
    trustZones: { a: "trusted", b: "trusted" },
    importance: { a: 0.9, b: 0.9 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ambiguous");
});


test("tryDirectAnswer throws AbortError when signal aborts mid-loop", async () => {
  const first = makeMemory({
    id: "first",
    tags: ["package-manager"],
    content: "remnic uses pnpm",
  });
  const second = makeMemory({
    id: "second",
    tags: ["package-manager"],
    content: "remnic uses pnpm",
  });

  const controller = new AbortController();
  let secondTrustZoneConsulted = false;
  const sources: DirectAnswerSources = {
    taxonomy: DEFAULT_TAXONOMY,
    listCandidateMemories: async () => [first, second],
    trustZoneFor: async (id: string) => {
      if (id === "first") {
        controller.abort();
        return "trusted";
      }
      secondTrustZoneConsulted = true;
      return "trusted";
    },
    importanceFor: () => 0.9,
  };
  await assert.rejects(
    () =>
      tryDirectAnswer({
        query: "package manager remnic",
        namespace: "default",
        config: BASE_CONFIG,
        enabled: true,
        sources,
        abortSignal: controller.signal,
      }),
    (err: Error) => err.name === "AbortError",
  );
  assert.equal(secondTrustZoneConsulted, false);
});

test("tryDirectAnswer throws when abort lands during trustZoneFor on the only memory", async () => {
  const memory = makeMemory({
    id: "only",
    tags: ["package-manager", "remnic"],
    content: "remnic uses pnpm",
  });
  const controller = new AbortController();
  const sources: DirectAnswerSources = {
    taxonomy: DEFAULT_TAXONOMY,
    listCandidateMemories: async () => [memory],
    trustZoneFor: async () => {
      controller.abort();
      return "trusted";
    },
    importanceFor: () => 0.9,
  };
  await assert.rejects(
    () =>
      tryDirectAnswer({
        query: "package manager remnic",
        namespace: "default",
        config: BASE_CONFIG,
        enabled: true,
        sources,
        abortSignal: controller.signal,
      }),
    (err: Error) => err.name === "AbortError",
  );
});

test("tryDirectAnswer throws when abort lands during trustZoneFor on the last of several memories", async () => {
  const memories = [
    makeMemory({ id: "first", tags: ["package-manager"], content: "remnic uses pnpm" }),
    makeMemory({ id: "last", tags: ["package-manager"], content: "remnic uses pnpm" }),
  ];
  const controller = new AbortController();
  const sources: DirectAnswerSources = {
    taxonomy: DEFAULT_TAXONOMY,
    listCandidateMemories: async () => memories,
    trustZoneFor: async (id: string) => {
      if (id === "last") controller.abort();
      return "trusted";
    },
    importanceFor: () => 0.9,
  };
  await assert.rejects(
    () =>
      tryDirectAnswer({
        query: "package manager remnic",
        namespace: "default",
        config: BASE_CONFIG,
        enabled: true,
        sources,
        abortSignal: controller.signal,
      }),
    (err: Error) => err.name === "AbortError",
  );
});

test("tryDirectAnswer throws when signal is already aborted before I/O", async () => {
  const sources = makeMockSources({ memories: [makeMemory()] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      tryDirectAnswer({
        query: "anything",
        namespace: "default",
        config: BASE_CONFIG,
        enabled: true,
        sources,
        abortSignal: controller.signal,
      }),
    (err: Error) => err.name === "AbortError",
  );
  assert.equal(sources.calls.listCandidates, 0);
});


test("tryDirectAnswer passes the requested namespace to listCandidateMemories", async () => {
  let observedNamespace: string | null = null;
  const sources: DirectAnswerSources = {
    taxonomy: DEFAULT_TAXONOMY,
    listCandidateMemories: async ({ namespace }) => {
      observedNamespace = namespace;
      return [];
    },
    trustZoneFor: async () => null,
    importanceFor: () => 0,
  };
  await tryDirectAnswer({
    query: "anything",
    namespace: "project-x",
    config: BASE_CONFIG,
    enabled: true,
    sources,
  });
  assert.equal(observedNamespace, "project-x");
});


test("tryDirectAnswer forwards queryEntityRefs to the eligibility gate", async () => {
  const match = makeMemory({
    id: "match",
    verificationState: "user_confirmed",
    entityRef: "remnic",
    tags: ["package-manager"],
    content: "remnic uses pnpm",
  });
  const mismatch = makeMemory({
    id: "mismatch",
    verificationState: "user_confirmed",
    entityRef: "weclone",
    tags: ["package-manager"],
    content: "weclone uses npm",
  });
  const sources = makeMockSources({
    memories: [match, mismatch],
    trustZones: { match: "trusted", mismatch: "trusted" },
    importance: { match: 0.9, mismatch: 0.9 },
  });
  const result = await tryDirectAnswer({
    query: "package manager remnic",
    namespace: "default",
    config: BASE_CONFIG,
    enabled: true,
    sources,
    queryEntityRefs: ["remnic"],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.winner?.memory.frontmatter.id, "match");
});
