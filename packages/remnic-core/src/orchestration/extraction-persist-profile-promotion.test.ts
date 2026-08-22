import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Orchestrator, StorageManager } from "../index.js";
import { parseConfig } from "../config.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import type { ExtractionResult, MemoryFile } from "../types.js";

// #2330 round N+8 (P1-A): a profile-only auto-promotion plan writes the
// profile copy but skips shared promotion, so `promoteMemoryToShared` used to
// return undefined and the caller's reconciliation guard skipped the
// stale-copy retirement. This suite drives the REAL persistExtraction path
// (judge-mediated merge → merged-target promotion → reconciliation) with a
// profile-only scope plan and a concurrent pre-merge publication interleaved
// at the promoted-copy probe's scan, then asserts exactly ONE active profile
// copy carrying the merged body.
//
// Synthetic fixtures only — no real paths, hosts, or memory content.

const TEAM_NS = "team-promotarget";
const TARGET_ID = "fact-target-merge";
const SEED = "The billing service deploys on a Tuesday cadence.";
const INCOMING = "The billing service deploys at 09:00 UTC sharp.";
const MERGED_BODY = `${SEED} ${INCOMING}`;

interface TestSurface {
  getStorage: (namespace: string) => Promise<StorageManager>;
  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction: string | null,
    sourceContext?: unknown,
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
  ) => Promise<{ persistedIds: string[] }>;
  embeddingFallback: {
    isAvailable: () => Promise<boolean>;
    search: (
      query: string,
      limit: number,
      options?: unknown,
    ) => Promise<Array<{ id: string; score: number; path: string }>>;
    indexFile: (id: string, content: string, path: string) => Promise<void>;
    removeFromIndex: (id: string) => Promise<void>;
  };
  localLlm: {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
    ) => Promise<{ content: string } | null>;
  };
}

/** Profile-only plan: `userGlobal` auto-promotes; `serverShared` is absent. */
function profileOnlyScopePlan(
  minConfidenceTier: "speculative" | "implied" = "speculative",
): ResolvedScopeProfilePlan {
  return {
    profileId: "synthetic-profile-only",
    profile: {
      readOrder: ["userProject"],
      writeDefault: "userProject",
      promotionTargets: ["userGlobal"],
      autoPromote: {
        enabled: true,
        targets: ["userGlobal"],
        categories: ["fact"],
        minConfidenceTier,
      },
    },
    baseNamespace: "default",
    writeLayer: "userProject",
    writeNamespace: "default",
    readNamespaces: ["default", TEAM_NS],
    layers: [
      {
        id: "userProject",
        kind: "user-project",
        namespace: "default",
        readable: true,
        writable: true,
        promotable: false,
        reason: "test",
      },
    ],
    promotionTargets: [
      { target: "userGlobal", namespace: TEAM_NS, authorized: true, reason: "test" },
    ],
    warnings: [],
  } as unknown as ResolvedScopeProfilePlan;
}

test("merged-target promotion reconciles profile copies in a profile-only plan (P1-A)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-pp-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: true,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      versioningEnabled: true,
      semanticMerge: { enabled: true },
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const orchestrator = new Orchestrator(config) as unknown as TestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const teamStorage = await orchestrator.getStorage(TEAM_NS);
    await teamStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // Seed a merge target with past timestamps and high importance so the
    // incoming fact never bypasses as unpreservable metadata.
    const created = new Date(Date.now() - 3600_000).toISOString();
    const seededDir = path.join(storage.dir, "facts", created.slice(0, 10));
    await mkdir(seededDir, { recursive: true });
    await writeFile(
      path.join(seededDir, `${TARGET_ID}.md`),
      [
        "---",
        `id: ${TARGET_ID}`,
        "category: fact",
        `created: ${created}`,
        `updated: ${created}`,
        "source: extraction",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "status: active",
        "importanceScore: 0.9",
        "importanceLevel: high",
        "---",
        "",
        SEED,
        "",
      ].join("\n"),
      "utf8",
    );

    // Band neighbor for the incoming fact only ([minSimilarity, threshold)).
    orchestrator.embeddingFallback = {
      isAvailable: async () => true,
      search: async (query) =>
        query === INCOMING ? [{ id: TARGET_ID, score: 0.85, path: "" }] : [],
      indexFile: async () => {},
      removeFromIndex: async () => {},
    };
    orchestrator.localLlm = {
      chatCompletion: async (messages) => {
        if (
          messages[0]?.role !== "system" ||
          !messages[0].content.startsWith("You maintain a long-term memory store")
        ) {
          return null;
        }
        const input = JSON.parse(messages[1]?.content ?? "{}") as {
          new?: { content?: string };
          existing?: Array<{ id?: string; content?: string }>;
        };
        const target = input.existing?.[0];
        if (
          !target?.id ||
          typeof target.content !== "string" ||
          typeof input.new?.content !== "string"
        ) {
          return {
            content: JSON.stringify({
              decision: "create",
              targetId: null,
              mergedContent: null,
              reason: "no candidate",
            }),
          };
        }
        return {
          content: JSON.stringify({
            decision: "merge",
            targetId: target.id,
            mergedContent: `${target.content} ${input.new.content}`.trim(),
            reason: "deterministic judge for profile-only reconciliation",
          }),
        };
      },
    };

    // Interleave at the REAL seam: the promoted-copy probe scans the team
    // namespace through readAllMemories. On that first scan only, a
    // concurrent writer publishes the PRE-merge profile copy right after the
    // read resolves — the probe still returns the pre-publication corpus, so
    // the merge proceeds exactly as in the production race.
    let probeScanDone = false;
    const originalReadAll = teamStorage.readAllMemories.bind(teamStorage);
    let staleCopyId = "";
    teamStorage.readAllMemories = async (): Promise<MemoryFile[]> => {
      const corpus = await originalReadAll();
      if (!probeScanDone) {
        probeScanDone = true;
        const stale = await teamStorage.writeMemory("fact", SEED, {
          source: "test",
          sourceMemoryId: TARGET_ID,
        });
        staleCopyId = stale.id;
      }
      return corpus;
    };

    const result: ExtractionResult = {
      facts: [
        {
          category: "fact",
          content: INCOMING,
          confidence: 0.9,
          tags: [],
        },
      ],
      entities: [],
      profileUpdates: [],
      questions: [],
      relationships: [],
    };
    const { persistedIds } = await orchestrator.persistExtraction(
      result,
      storage,
      null,
      undefined,
      "default",
      profileOnlyScopePlan(),
    );
    assert.deepEqual(persistedIds, [], "the merged target is not a new fragment");

    // The interleaved publication happened exactly as modeled.
    assert.ok(staleCopyId, "the concurrent pre-merge publication must have run");

    const teamCorpus = await originalReadAll();
    const linked = teamCorpus.filter(
      (memory) => memory.frontmatter.sourceMemoryId === TARGET_ID,
    );
    const active = linked.filter(
      (memory) => (memory.frontmatter.status ?? "active") === "active",
    );
    assert.equal(
      active.length,
      1,
      `exactly one active profile copy must carry the merged body (got ${linked.length} linked: ${linked
        .map((m) => `${m.frontmatter.id}:${m.frontmatter.status ?? "active"}`)
        .join(", ")})`,
    );
    assert.equal(
      active[0]?.content,
      MERGED_BODY,
      "the surviving copy serves the merged body",
    );
    const staleRow = await teamStorage.getMemoryByIdIncludingArchived(staleCopyId);
    assert.equal(
      staleRow?.frontmatter.status,
      "superseded",
      "the interleaved pre-merge copy must be retired",
    );
    assert.equal(staleRow?.frontmatter.supersededBy, active[0]?.frontmatter.id);

    // Profile-only means no shared copy was written either.
    const sharedCorpus = await sharedStorage.readAllMemories();
    assert.equal(
      sharedCorpus.filter((m) => m.frontmatter.sourceMemoryId === TARGET_ID)
        .length,
      0,
      "a profile-only plan must not promote to the shared namespace",
    );
  } finally {
    await StorageManager.clearAllStaticCaches();
  }
});

// #2330 round N+10 (A): the P1-A race, minus the replacement promotion. A
// low-confidence incoming fact merges into the high-confidence target and
// DOWNGRADES the committed record below the plan's promotion minimum, so
// `promoteMemoryToShared` returns undefined — no copy of the merged body is
// written. The concurrent pre-merge publication must still be reconciled:
// the stale copy retires onto the committed target, leaving ZERO active
// copies ("none is warranted" at the downgraded tier).
test("below-threshold merged target still reconciles the stale profile copy (round N+10 A)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-pp-bt-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: true,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      versioningEnabled: true,
      semanticMerge: { enabled: true },
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const orchestrator = new Orchestrator(config) as unknown as TestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const teamStorage = await orchestrator.getStorage(TEAM_NS);
    await teamStorage.ensureDirectories();

    // Same seed as P1-A: high-confidence target.
    const created = new Date(Date.now() - 3600_000).toISOString();
    const seededDir = path.join(storage.dir, "facts", created.slice(0, 10));
    await mkdir(seededDir, { recursive: true });
    await writeFile(
      path.join(seededDir, `${TARGET_ID}.md`),
      [
        "---",
        `id: ${TARGET_ID}`,
        "category: fact",
        `created: ${created}`,
        `updated: ${created}`,
        "source: extraction",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "status: active",
        "importanceScore: 0.9",
        "importanceLevel: high",
        "---",
        "",
        SEED,
        "",
      ].join("\n"),
      "utf8",
    );

    orchestrator.embeddingFallback = {
      isAvailable: async () => true,
      search: async (query) =>
        query === INCOMING ? [{ id: TARGET_ID, score: 0.85, path: "" }] : [],
      indexFile: async () => {},
      removeFromIndex: async () => {},
    };
    orchestrator.localLlm = {
      chatCompletion: async (messages) => {
        if (
          messages[0]?.role !== "system" ||
          !messages[0].content.startsWith("You maintain a long-term memory store")
        ) {
          return null;
        }
        const input = JSON.parse(messages[1]?.content ?? "{}") as {
          new?: { content?: string };
          existing?: Array<{ id?: string; content?: string }>;
        };
        const target = input.existing?.[0];
        if (
          !target?.id ||
          typeof target.content !== "string" ||
          typeof input.new?.content !== "string"
        ) {
          return {
            content: JSON.stringify({
              decision: "create",
              targetId: null,
              mergedContent: null,
              reason: "no candidate",
            }),
          };
        }
        return {
          content: JSON.stringify({
            decision: "merge",
            targetId: target.id,
            mergedContent: `${target.content} ${input.new.content}`.trim(),
            reason: "deterministic judge for below-threshold reconciliation",
          }),
        };
      },
    };

    // Same interleaving as P1-A: the probe's first team-namespace scan
    // publishes the PRE-merge profile copy right after the read resolves.
    let probeScanDone = false;
    const originalReadAll = teamStorage.readAllMemories.bind(teamStorage);
    let staleCopyId = "";
    teamStorage.readAllMemories = async (): Promise<MemoryFile[]> => {
      const corpus = await originalReadAll();
      if (!probeScanDone) {
        probeScanDone = true;
        const stale = await teamStorage.writeMemory("fact", SEED, {
          source: "test",
          sourceMemoryId: TARGET_ID,
        });
        staleCopyId = stale.id;
      }
      return corpus;
    };

    // The downgrade: incoming confidence 0.5 (inferred) against a plan whose
    // promotion minimum is "implied" — the merged record keeps min(0.5, 0.9)
    // and is no longer promotable, so no replacement copy can be written.
    const result: ExtractionResult = {
      facts: [
        {
          category: "fact",
          content: INCOMING,
          confidence: 0.5,
          tags: [],
        },
      ],
      entities: [],
      profileUpdates: [],
      questions: [],
      relationships: [],
    };
    const { persistedIds } = await orchestrator.persistExtraction(
      result,
      storage,
      null,
      undefined,
      "default",
      profileOnlyScopePlan("implied"),
    );
    assert.deepEqual(persistedIds, [], "the merged target is not a new fragment");
    assert.ok(staleCopyId, "the concurrent pre-merge publication must have run");
    // The merge committed and the downgrade landed on the record.
    const committed = await storage.getMemoryByIdIncludingArchived(TARGET_ID);
    assert.equal(committed?.content, MERGED_BODY);
    assert.equal(committed?.frontmatter.confidence, 0.5);

    const teamCorpus = await originalReadAll();
    const linked = teamCorpus.filter(
      (memory) => memory.frontmatter.sourceMemoryId === TARGET_ID,
    );
    const active = linked.filter(
      (memory) => (memory.frontmatter.status ?? "active") === "active",
    );
    assert.equal(
      active.length,
      0,
      `no active copy is warranted below the promotion threshold (got ${linked
        .map((m) => `${m.frontmatter.id}:${m.frontmatter.status ?? "active"}`)
        .join(", ")})`,
    );
    const staleRow = await teamStorage.getMemoryByIdIncludingArchived(staleCopyId);
    assert.equal(
      staleRow?.frontmatter.status,
      "superseded",
      "the interleaved pre-merge copy must be retired even with no replacement promotion",
    );
    assert.equal(staleRow?.frontmatter.supersededBy, TARGET_ID);
  } finally {
    await StorageManager.clearAllStaticCaches();
  }
});
