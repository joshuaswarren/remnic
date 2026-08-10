import assert from "node:assert/strict";
import test from "node:test";

import { findDependents, propagateInvalidation } from "./dependency-propagation.js";
import type { ExtractionEngine } from "../extraction.js";
import type { MemoryFile, MemoryLinkType, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { invalidationCommitFingerprint } from "../storage/deletion-revision-store.js";

type Verdict = {
  memoryId: string;
  verdict: "still_valid" | "invalidated" | "uncertain" | string;
  reason?: string;
};

type RevalidationCall = {
  superseded: { id: string; content: string };
  replacement: { id: string; content: string } | null;
  dependents: Array<{ id: string; category: string; content: string }>;
  signal: AbortSignal | undefined;
};

type Fixture = {
  memories: Map<string, MemoryFile>;
  storage: StorageManager;
  extraction: ExtractionEngine;
  calls: {
    revalidate: RevalidationCall[];
    supersede: Array<{
      id: string;
      replacementId: string;
      reason: string;
      metadata?: Record<string, unknown>;
      options: {
        requireActive?: boolean;
        acceptExactReplay?: boolean;
        expectedSnapshot?: Pick<MemoryFile, "content" | "frontmatter"> & Partial<Pick<MemoryFile, "path">>;
      };
    }>;
  };
};

const NOW = "2026-08-08T00:00:00.000Z";

function memory(
  id: string,
  options: {
    status?: string;
    links?: Array<{ targetId: string; linkType: MemoryLinkType; strength?: number }>;
    category?: string;
    content?: string;
  } = {},
): MemoryFile {
  return {
    path: `/synthetic/${id}.md`,
    content: options.content ?? `claim for ${id}`,
    frontmatter: {
      id,
      category: (options.category ?? "fact") as MemoryFile["frontmatter"]["category"],
      created: NOW,
      updated: NOW,
      source: "synthetic-test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      status: (options.status ?? "active") as MemoryFile["frontmatter"]["status"],
      links: options.links?.map((link) => ({
        targetId: link.targetId,
        linkType: link.linkType,
        strength: link.strength ?? 0.9,
      })),
    },
  } as unknown as MemoryFile;
}

function config(overrides: Record<string, unknown> = {}): PluginConfig {
  return {
    dependencyPropagation: {
      enabled: true,
      linkTypes: ["supports", "follows"],
      maxDependents: 10,
      timeoutMs: 50,
      dryRun: false,
      ...(overrides.dependencyPropagation as Record<string, unknown> | undefined),
    },

  } as unknown as PluginConfig;
}

function fixture(
  initial: MemoryFile[],
  verdicts: Verdict[] | Error | ((signal?: AbortSignal) => Promise<{ verdicts: Verdict[] }>),
): Fixture {
  const memories = new Map(initial.map((item) => [item.frontmatter.id, item]));
  const calls: Fixture["calls"] = { revalidate: [], supersede: [] };
  const storage = {

    async readAllMemories(): Promise<MemoryFile[]> {
      return structuredClone([...memories.values()]);
    },
    async getMemoryById(id: string): Promise<MemoryFile | null> {
      return memories.get(id) ?? null;
    },
    async supersedeMemory(
      id: string,
      replacementId: string,
      reason: string,
      metadata?: Record<string, unknown>,
      options: {
        requireActive?: boolean;
        acceptExactReplay?: boolean;
        expectedSnapshot?: Pick<MemoryFile, "content" | "frontmatter"> & Partial<Pick<MemoryFile, "path">>;
      } = {},
    ): Promise<boolean> {
      calls.supersede.push({ id, replacementId, reason, metadata, options });
      const current = memories.get(id);
      if (!current) return false;
      if (
        options.expectedSnapshot &&
        invalidationCommitFingerprint(current) !== invalidationCommitFingerprint(options.expectedSnapshot)
      ) {
        return false;
      }
      const exactReplay =
        current.frontmatter.status === "superseded" &&
        current.frontmatter.supersededBy === replacementId &&
        current.frontmatter.supersessionCause === metadata?.supersessionCause &&
        current.frontmatter.invalidatedBy === metadata?.invalidatedBy;
      if (exactReplay) return options.acceptExactReplay === true;
      if (
        options.requireActive === true &&
        (current.frontmatter.status ?? "active") !== "active"
      ) {
        return false;
      }
      Object.assign(current.frontmatter, metadata, {
        status: "superseded",
        supersededBy: replacementId,
      });
      return true;
    },
  } as unknown as StorageManager;

  const extraction = {
    async revalidateDependents(
      superseded: { id: string; content: string },
      replacement: { id: string; content: string } | null,
      dependents: Array<{ id: string; category: string; content: string }>,
      signal?: AbortSignal,
    ): Promise<{ verdicts: Verdict[] }> {
      calls.revalidate.push({ superseded, replacement, dependents, signal });
      if (typeof verdicts === "function") return verdicts(signal);
      if (verdicts instanceof Error) throw verdicts;
      return { verdicts };
    },
  } as unknown as ExtractionEngine;

  return { memories, storage, extraction, calls };
}

function deps(fixtureValue: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    storage: fixtureValue.storage,
    extraction: fixtureValue.extraction,
    config: config(overrides),
  };
}

test("findDependents discovers forward supports and reverse follows together", () => {
  const old = memory("old", {
    links: [
      { targetId: "forward", linkType: "supports" },
      { targetId: "not-dependent", linkType: "references" },
    ],
  });
  const forward = memory("forward");
  const reverse = memory("reverse", {
    links: [{ targetId: "old", linkType: "follows" }],
  });
  const supporter = memory("supporter", {
    links: [{ targetId: "old", linkType: "supports" }],
  });

  assert.deepEqual(
    findDependents([reverse, supporter, forward], old, ["supports", "follows"]).map(
      (item) => item.frontmatter.id,
    ),
    ["forward", "reverse"],
  );
});

test("findDependents includes references only when configured", () => {
  const old = memory("old", {
    links: [{ targetId: "forward-reference", linkType: "references" }],
  });
  const forwardReference = memory("forward-reference");
  const reverseReference = memory("reverse-reference", {
    links: [{ targetId: "old", linkType: "references" }],
  });

  assert.deepEqual(findDependents([forwardReference, reverseReference], old, ["supports", "follows"]), []);
  assert.deepEqual(
    findDependents([forwardReference, reverseReference], old, ["supports", "follows", "references"]).map(
      (item) => item.frontmatter.id,
    ),
    ["forward-reference", "reverse-reference"],
  );
});

test("findDependents excludes every non-active status", () => {
  const old = memory("old", {
    links: [
      { targetId: "active", linkType: "supports" },
      { targetId: "pending_review", linkType: "supports" },
      { targetId: "superseded", linkType: "supports" },
      { targetId: "archived", linkType: "supports" },
      { targetId: "quarantined", linkType: "supports" },
      { targetId: "rejected", linkType: "supports" },
      { targetId: "forgotten", linkType: "supports" },
    ],
  });
  const statuses = ["active", "pending_review", "superseded", "archived", "quarantined", "rejected", "forgotten"];
  const candidates = statuses.map((status) => memory(status, { status }));
  const reverseCandidates = statuses.map((status) =>
    memory(`reverse-${status}`, { status, links: [{ targetId: "old", linkType: "follows" }] }),
  );

  assert.deepEqual(
    findDependents([...candidates, ...reverseCandidates], old, ["supports", "follows"]).map(
      (item) => item.frontmatter.id,
    ),
    ["active", "reverse-active"],
  );
});

test("propagateInvalidation sorts dependents by id before applying the cap", async () => {
  const old = memory("old", {
    links: [
      { targetId: "dep-c", linkType: "supports" },
      { targetId: "dep-a", linkType: "supports" },
      { targetId: "dep-b", linkType: "supports" },
    ],
  });
  const fixtureValue = fixture([old, memory("dep-c"), memory("dep-a"), memory("dep-b")], [
    { memoryId: "dep-a", verdict: "still_valid" },
    { memoryId: "dep-b", verdict: "still_valid" },
  ]);

  const result = await propagateInvalidation(
    deps(fixtureValue, { dependencyPropagation: { maxDependents: 2 } }),
    {
      oldMemory: old,
      replacementId: "replacement",
      replacementContent: "new claim",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.dependentsFound, 2);
  assert.deepEqual(fixtureValue.calls.revalidate[0]?.dependents.map((dep) => dep.id), ["dep-a", "dep-b"]);
});

test("maxDependents zero disables propagation without an LLM call", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep")], [{ memoryId: "dep", verdict: "invalidated" }]);

  const result = await propagateInvalidation(
    deps(fixtureValue, { dependencyPropagation: { maxDependents: 0 } }),
    {
      oldMemory: old,
      replacementId: null,
      replacementContent: null,
      cause: "consolidation_invalidate",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.dependentsFound, 0);
  assert.equal(result.skipped, "no_dependents");
  assert.equal(fixtureValue.calls.revalidate.length, 0);
  assert.equal(fixtureValue.calls.supersede.length, 0);
});

test("disabled propagation is an immediate no-op for boolean and string false", async () => {
  for (const enabled of [false, "false"]) {
    const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
    const fixtureValue = fixture([old, memory("dep")], [{ memoryId: "dep", verdict: "invalidated" }]);
    const result = await propagateInvalidation(
      deps(fixtureValue, { dependencyPropagation: { enabled } }),
      {
        oldMemory: old,
        replacementId: "new",
        replacementContent: "replacement",
        cause: "contradiction",
        namespaceScope: "namespace-a",
      },
    );

    assert.deepEqual(
      {
        dependentsFound: result.dependentsFound,
        invalidated: result.invalidated,
        stillValid: result.stillValid,
        uncertain: result.uncertain,
        skipped: result.skipped,
      },
      {
        dependentsFound: 0,
        invalidated: 0,
        stillValid: 0,
        uncertain: 0,
        skipped: "disabled",
      },
    );
    assert.equal(result.route, null);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(fixtureValue.calls.revalidate.length, 0);
  }
});

test("invalidated verdict supersedes the dependent and persists dependency frontmatter", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const dependent = memory("dep");
  const fixtureValue = fixture([old, dependent], [{ memoryId: "dep", verdict: "invalidated", reason: "claim lost support" }]);
  const expectedSnapshot = structuredClone(dependent);

  const result = await propagateInvalidation(
    deps(fixtureValue),
    {
      oldMemory: old,
      replacementId: "replacement",
      replacementContent: "replacement claim",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.invalidated, 1);
  assert.equal(result.dependentsFound, 1);
  assert.equal(result.stillValid, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(result.skipped, null);
  assert.equal(result.route, "fast-completion");
  assert.equal(typeof result.durationMs, "number");
  assert.deepEqual(fixtureValue.calls.supersede, [
    {
      id: "dep",
      replacementId: "replacement",
      reason: "dependency_propagation:contradiction",
      metadata: { supersessionCause: "dependency", invalidatedBy: "old" },
      options: { requireActive: true, acceptExactReplay: true, expectedSnapshot },
    },
  ]);
  assert.equal(fixtureValue.memories.get("dep")?.frontmatter.status, "superseded");
  assert.equal(fixtureValue.memories.get("dep")?.frontmatter.supersessionCause, "dependency");
  assert.equal(fixtureValue.memories.get("dep")?.frontmatter.invalidatedBy, "old");
});
test("supersede fixture rejects a stale expected snapshot after concurrent mutation", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const dependent = memory("dep");
  const fixtureValue = fixture([old, dependent], []);
  const expectedSnapshot = structuredClone(dependent);
  dependent.content = "concurrent update";

  const superseded = await fixtureValue.storage.supersedeMemory(
    "dep",
    "replacement",
    "dependency_propagation:contradiction",
    { supersessionCause: "dependency", invalidatedBy: "old" },
    { requireActive: true, expectedSnapshot },
  );

  assert.equal(superseded, false);
  assert.equal(fixtureValue.memories.get("dep")?.frontmatter.status, "active");
});

test("still_valid and uncertain verdicts do not write", async () => {
  const old = memory("old", {
    links: [
      { targetId: "still", linkType: "supports" },
      { targetId: "unsure", linkType: "supports" },
    ],
  });
  const fixtureValue = fixture([old, memory("still"), memory("unsure")], [
    { memoryId: "still", verdict: "still_valid" },
    { memoryId: "unsure", verdict: "uncertain" },
  ]);

  const result = await propagateInvalidation(
    deps(fixtureValue),
    {
      oldMemory: old,
      replacementId: null,
      replacementContent: null,
      cause: "temporal_supersession",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.stillValid, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(fixtureValue.calls.supersede.length, 0);
});

test("unknown, missing, and garbage verdicts default to uncertain and drop unknown ids", async () => {
  const old = memory("old", {
    links: [
      { targetId: "missing", linkType: "supports" },
      { targetId: "garbage", linkType: "supports" },
    ],
  });
  const fixtureValue = fixture([old, memory("garbage"), memory("missing")], [
    { memoryId: "missing", verdict: "not-a-verdict" },
    { memoryId: "ghost", verdict: "invalidated" },
    { memoryId: "garbage", verdict: "" },
  ]);

  const result = await propagateInvalidation(
    deps(fixtureValue),
    {
      oldMemory: old,
      replacementId: null,
      replacementContent: null,
      cause: "consolidation_invalidate",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.invalidated, 0);
  assert.equal(result.stillValid, 0);
  assert.equal(result.uncertain, 2);
  assert.equal(fixtureValue.calls.supersede.length, 0);
});

test("LLM errors skip the event and perform zero writes", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep")], new Error("LLM unavailable"));

  const result = await propagateInvalidation(
    deps(fixtureValue),
    {
      oldMemory: old,
      replacementId: "new",
      replacementContent: "replacement",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.dependentsFound, 1);
  assert.equal(result.invalidated, 0);
  assert.equal(result.stillValid, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(result.route, "fast-completion");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.skipped, "llm_error");
  assert.equal(fixtureValue.calls.supersede.length, 0);
});

test("LLM timeout aborts the batch and performs zero writes", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep")], (signal) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  );

  const result = await propagateInvalidation(
    deps(fixtureValue, { dependencyPropagation: { timeoutMs: 1 } }),
    {
      oldMemory: old,
      replacementId: "new",
      replacementContent: "replacement",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.dependentsFound, 1);
  assert.equal(result.route, "fast-completion");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.skipped, "timeout");
  assert.equal(fixtureValue.calls.supersede.length, 0);
});

test("a completion that ignores AbortSignal returns at the shared deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
    const fixtureValue = fixture([old, memory("dep")], () => new Promise<never>(() => {}));
    const resultPromise = propagateInvalidation(
      deps(fixtureValue, { dependencyPropagation: { timeoutMs: 20 } }),
      {
        oldMemory: old,
        replacementId: "new",
        replacementContent: "replacement",
        cause: "contradiction",
        namespaceScope: "namespace-a",
      },
    );

    await Promise.resolve();
    t.mock.timers.tick(20);
    const result = await resultPromise;

    assert.equal(result.dependentsFound, 1);
    assert.equal(result.invalidated, 0);
    assert.equal(result.stillValid, 0);
    assert.equal(result.uncertain, 0);
    assert.equal(result.skipped, "timeout");
    assert.equal(result.route, "fast-completion");
    assert.equal(result.durationMs, 20);
    assert.equal(fixtureValue.calls.supersede.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("a zero timeout disables the deadline", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep")], () =>
    new Promise((resolve) => setTimeout(() => resolve({
      verdicts: [{ memoryId: "dep", verdict: "invalidated" }],
    }), 5)),
  );
  const result = await propagateInvalidation(
    deps(fixtureValue, { dependencyPropagation: { timeoutMs: 0 } }),
    {
      oldMemory: old,
      replacementId: "new",
      replacementContent: "replacement",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );
  assert.equal(result.invalidated, 1);
  assert.equal(result.skipped, null);
});

test("dryRun computes invalidation verdicts without writing", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep")], [{ memoryId: "dep", verdict: "invalidated" }]);

  const result = await propagateInvalidation(
    deps(fixtureValue, { dependencyPropagation: { dryRun: true } }),
    {
      oldMemory: old,
      replacementId: null,
      replacementContent: null,
      cause: "consolidation_invalidate",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(result.invalidated, 1);
  assert.equal(fixtureValue.calls.revalidate.length, 1);
  assert.equal(fixtureValue.calls.supersede.length, 0);
  assert.equal(fixtureValue.memories.get("dep")?.frontmatter.status, "active");
});

test("revalidation receives the full signature, ordered dependents, and replacement context", async () => {
  const old = memory("old", { links: [{ targetId: "dep", linkType: "supports" }] });
  const fixtureValue = fixture([old, memory("dep", { category: "decision", content: "use the new service" })], [
    { memoryId: "dep", verdict: "still_valid" },
  ]);

  await propagateInvalidation(
    deps(fixtureValue),
    {
      oldMemory: old,
      replacementId: "new",
      replacementContent: "the new service is available",
      cause: "contradiction",
      namespaceScope: "namespace-a",
    },
  );

  const call = fixtureValue.calls.revalidate[0];
  assert.ok(call);
  assert.deepEqual(call.superseded, { id: "old", content: "claim for old" });
  assert.deepEqual(call.replacement, { id: "new", content: "the new service is available" });
  assert.deepEqual(call.dependents, [{ id: "dep", category: "decision", content: "use the new service" }]);
  assert.ok(call.signal instanceof AbortSignal);
});

test("propagation reads only the provided namespace storage", async () => {
  const oldA = memory("old", { links: [{ targetId: "dep-a", linkType: "supports" }] });
  const depA = memory("dep-a");
  const depB = memory("dep-b");
  const namespaceA = fixture([oldA, depA], [{ memoryId: "dep-a", verdict: "invalidated" }]);
  const namespaceB = fixture([depB], [{ memoryId: "dep-b", verdict: "invalidated" }]);

  await propagateInvalidation(
    deps(namespaceA),
    {
      oldMemory: oldA,
      replacementId: null,
      replacementContent: null,
      cause: "consolidation_invalidate",
      namespaceScope: "namespace-a",
    },
  );

  assert.equal(namespaceA.memories.get("dep-a")?.frontmatter.status, "superseded");
  assert.equal(namespaceB.memories.get("dep-b")?.frontmatter.status, "active");
  assert.equal(namespaceB.calls.revalidate.length, 0);
});
