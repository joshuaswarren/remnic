/**
 * Surface contract tests for the architecture-card handler
 * (issue #1548 Track A PR 3).
 *
 * Contract under test:
 *  - Gate predicate: enabled + architectureCard + coding context (rule 39).
 *  - get: returns not-found when no card exists, found+content when it does.
 *  - refresh: builds → persists → versions; first write vs update path.
 *  - Build failure → tagged failure, nothing persisted (rule 34/44).
 *  - Invalid subcommand → error listing valid options (rule 51).
 *
 * All fixtures are synthetic — no real repos (public-repo policy).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { type EngramAccessService } from "../access-service.js";
import { getOperation, type OperationName } from "../access-boundary.js";
import "../access-operations.js";
import { EngramMcpServer } from "../access-mcp.js";
import {
  ARCHITECTURE_SUBCOMMANDS,
  ARCHITECTURE_CARD_TAG,
  ARCHITECTURE_CARD_KIND,
  handleCodingArchitecture,
  isArchitectureSubcommand,
  formatArchitectureSubcommands,
  findArchitectureCardMemory,
  type ArchitectureSurfaceContext,
  type ArchitectureSurfaceRequest,
  type ArchitectureSurfaceStorage,
} from "./architecture-surfaces.js";
import { isCodingKnowledgeFeatureEnabled, isCodingKnowledgeFeatureVisible } from "./coding-knowledge-config.js";
import { sealedWriteToLegacyArgs } from "../write-envelope.js";
import type { ArchitectureCardBuildResult } from "./architecture-card.js";
import type {
  CodingKnowledgeConfig,
  CodingContext,
  MemoryFile,
  MemoryFrontmatter,
} from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const NOW = "2026-07-05T12:00:00.000Z";

const DEFAULT_CONFIG: CodingKnowledgeConfig = {
  enabled: true,
  decisionRecords: true,
  architectureCard: true,
  sessionDelta: true,
  architectureCardLlmSummary: false,
  structuralProvider: "none",
  structuralProviderCommand: "",
  codegraphTools: false,
  codegraphDbDir: "",
};

const CODING_CONTEXT: CodingContext = {
  projectId: "github.com/test/repo",
  branch: "main",
  rootPath: "/synthetic/repo",
  defaultBranch: "main",
};

function makeFrontmatter(overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
  return {
    id: "fact-test-card",
    category: "fact",
    created: NOW,
    updated: NOW,
    source: "coding-architecture",
    confidence: 1.0,
    confidenceTier: "explicit",
    tags: [ARCHITECTURE_CARD_TAG],
    structuredAttributes: { cardKind: ARCHITECTURE_CARD_KIND },
    ...overrides,
  };
}

function makeCardMemory(overrides: {
  content?: string;
  path?: string;
  frontmatter?: Partial<MemoryFrontmatter>;
} = {}): MemoryFile {
  const { frontmatter: fmOverrides, content, path: memPath } = overrides;
  return {
    path: memPath ?? "/synthetic/facts/test-card.md",
    frontmatter: makeFrontmatter(fmOverrides),
    content: content ?? "# Architecture Card\n\nsynthetic",
  };
}

interface StubStorage extends ArchitectureSurfaceStorage {
  memories: MemoryFile[];
  written: Array<{ category: string; content: string; options: Record<string, unknown> }>;
  updated: Array<{ id: string; content: string; options: Record<string, unknown> }>;
}

function makeStubStorage(initialMemories: MemoryFile[] = []): StubStorage {
  const allMemories: MemoryFile[] = [...initialMemories];
  const written: Array<{ category: string; content: string; options: Record<string, unknown> }> = [];
  const updated: Array<{ id: string; content: string; options: Record<string, unknown> }> = [];
  return {
    dir: "/synthetic/memory",
    namespace: "default",
    memories: allMemories,
    written,
    updated,
    async readAllMemories() { return [...allMemories]; },
    // Production mapper keeps the legacy-shaped recorder faithful (§21).
    async writeSealedMemory(envelope, extras) {
      const { category, content, options } = sealedWriteToLegacyArgs(envelope, extras as Record<string, unknown>);
      const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      written.push({ category, content, options });
      allMemories.push({
        path: `/synthetic/facts/${id}.md`,
        frontmatter: makeFrontmatter({ id, ...(options as Partial<MemoryFrontmatter>) }),
        content,
      });
      return { id: id, tombstoneBlocked: false };
    },
    async updateMemory(id, newContent, options) {
      updated.push({ id, content: newContent, options: options ?? {} });
      const m = allMemories.find((mem) => mem.frontmatter.id === id);
      if (m) {
        m.content = newContent;
        // Apply sourceConnector backfill to the in-memory frontmatter so
        // tests can verify the caller's intent matches what reaches storage.
        if (options?.sourceConnector) {
          (m.frontmatter as unknown as Record<string, unknown>).sourceConnector = options.sourceConnector;
        }
      }
      return !!m;
    },
  };
}

function makeContext(overrides: Partial<ArchitectureSurfaceContext> = {}): ArchitectureSurfaceContext {
  const storage = makeStubStorage();
  return {
    codingKnowledge: DEFAULT_CONFIG,
    getCodingContext: () => CODING_CONTEXT,
    resolveStorage: async () => storage,
    buildCard: async () => ({
      ok: true,
      card: {
        content: "# Architecture Card\n\nsynthetic",
        generatedAt: NOW,
        byteSize: 40,
        truncated: false,
      },
    }) satisfies ArchitectureCardBuildResult,
    versioning: { snapshotIfExists: async () => {} },
    throwInputError: (msg) => { throw new Error(msg); },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Subcommand validation
// ──────────────────────────────────────────────────────────────────────────

test("subcommands: isArchitectureSubcommand narrows valid values", () => {
  assert.equal(isArchitectureSubcommand("get"), true);
  assert.equal(isArchitectureSubcommand("refresh"), true);
  assert.equal(isArchitectureSubcommand("delete"), false);
  assert.equal(isArchitectureSubcommand(undefined), false);
  assert.equal(isArchitectureSubcommand(42), false);
});

test("subcommands: formatArchitectureSubcommands lists valid options", () => {
  const formatted = formatArchitectureSubcommands();
  for (const sub of ARCHITECTURE_SUBCOMMANDS) {
    assert.ok(formatted.includes(sub), `includes ${sub}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Gate predicates
// ──────────────────────────────────────────────────────────────────────────

test("gate: surface enabled when config + architectureCard + coding context all true", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "architectureCard", CODING_CONTEXT), true);
});

test("gate: surface disabled when master gate off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, enabled: false };
  assert.equal(isCodingKnowledgeFeatureEnabled(config, "architectureCard", CODING_CONTEXT), false);
});

test("gate: surface disabled when architectureCard off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, architectureCard: false };
  assert.equal(isCodingKnowledgeFeatureEnabled(config, "architectureCard", CODING_CONTEXT), false);
});

test("gate: surface disabled when no coding context", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "architectureCard", null), false);
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "architectureCard", undefined), false);
});

test("gate: visibility (tools/list) matches config-only check", () => {
  assert.equal(isCodingKnowledgeFeatureVisible(DEFAULT_CONFIG, "architectureCard"), true);
  assert.equal(isCodingKnowledgeFeatureVisible({ ...DEFAULT_CONFIG, enabled: false }, "architectureCard"), false);
  assert.equal(isCodingKnowledgeFeatureVisible({ ...DEFAULT_CONFIG, architectureCard: false }, "architectureCard"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Handler gate — throws when gate fails
// ──────────────────────────────────────────────────────────────────────────

test("handler: throws when gate is off (no coding context)", async () => {
  const ctx = makeContext({ getCodingContext: () => null });
  const request: ArchitectureSurfaceRequest = { subcommand: "get", sessionKey: "s1" };
  await assert.rejects(
    () => handleCodingArchitecture(request, ctx),
    /coding_architecture requires/,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// get — not-found when no card exists
// ──────────────────────────────────────────────────────────────────────────

test("get: returns found=false when no card exists in namespace", async () => {
  const ctx = makeContext();
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  assert.equal(result.subcommand, "get");
  if (result.subcommand !== "get") return;
  assert.equal(result.found, false);
  assert.equal(result.card, undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// get — found when card exists
// ──────────────────────────────────────────────────────────────────────────

test("get: returns found=true with card content when card exists", async () => {
  const cardContent = "# Architecture Card\n\nexisting content";
  const storage = makeStubStorage([makeCardMemory({ content: cardContent })]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  assert.equal(result.subcommand, "get");
  if (result.subcommand !== "get") return;
  assert.equal(result.found, true);
  assert.ok(result.card);
  assert.equal(result.card!.content, cardContent);
});

test("get: strips the [Attributes:] suffix writeMemory appends (cursor review)", async () => {
  // writeMemory appends `\n[Attributes: cardKind=architecture]` to the stored
  // body when structuredAttributes are present. The card markdown returned to
  // clients must NOT include that storage-metadata suffix, and byteSize must
  // reflect the card alone.
  const cardMarkdown = "# Architecture Card\n\nreal content";
  const storedContent = `${cardMarkdown}\n[Attributes: cardKind=architecture]`;
  const storage = makeStubStorage([makeCardMemory({ content: storedContent })]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "get") return;
  assert.equal(result.found, true);
  assert.ok(result.card);
  assert.equal(result.card!.content, cardMarkdown, "attributes suffix stripped from get content");
  assert.equal(result.card!.byteSize, Buffer.byteLength(cardMarkdown, "utf-8"), "byteSize excludes the suffix");
});

test("get: shares storage's stripper — legitimate trailing attributes-like line is not truncated (cursor review)", async () => {
  // The handler now uses the shared `stripAttributesSuffix` from
  // structured-attributes.ts (dedup). That helper only strips a single-line
  // enrichment whose payload has no premature `]` or embedded newline — so
  // card markdown that legitimately ends in an attributes-LIKE line (e.g. one
  // quoting a `[config]` token) is returned verbatim. The old local copy only
  // checked the trailing `]` and would have sliced this content in half.
  const cardMarkdown =
    "# Architecture Card\n\nreal content\n[Attributes: see the [config] section]";
  const storage = makeStubStorage([makeCardMemory({ content: cardMarkdown })]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "get") return;
  assert.equal(result.found, true);
  assert.ok(result.card);
  assert.equal(result.card!.content, cardMarkdown, "legitimate attributes-like line preserved, not truncated");
});

// ──────────────────────────────────────────────────────────────────────────
// refresh — first write (no existing card)
// ──────────────────────────────────────────────────────────────────────────

test("refresh: first card written via writeMemory, no version snapshot", async () => {
  const storage = makeStubStorage();
  const snapshots: MemoryFile[] = [];
  const ctx = makeContext({
    resolveStorage: async () => storage,
    versioning: {
      snapshotIfExists: async (m) => { snapshots.push(m); },
    },
  });
  const result = await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  assert.equal(result.subcommand, "refresh");
  if (result.subcommand !== "refresh") return;
  assert.equal(result.refreshed, true);
  assert.ok(result.memoryId, "memoryId returned");
  assert.equal(storage.written.length, 1, "one writeMemory call");
  assert.equal(storage.updated.length, 0, "no updateMemory call");
  assert.equal(snapshots.length, 0, "no version snapshot on first write (nothing to preserve)");
});

// ──────────────────────────────────────────────────────────────────────────
// refresh — update existing card (snapshot before overwrite, rule 25)
// ──────────────────────────────────────────────────────────────────────────

test("refresh: existing card snapshotted before update (rule 25)", async () => {
  const oldCard = makeCardMemory({ content: "# OLD CARD" });
  const storage = makeStubStorage([oldCard]);
  const snapshots: MemoryFile[] = [];
  const ctx = makeContext({
    resolveStorage: async () => storage,
    versioning: {
      snapshotIfExists: async (m) => { snapshots.push(m); },
    },
  });
  const result = await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  assert.equal(result.subcommand, "refresh");
  if (result.subcommand !== "refresh") return;
  assert.equal(result.refreshed, true);
  assert.equal(result.memoryId, oldCard.frontmatter.id, "same memory id (updated in place)");
  assert.equal(snapshots.length, 1, "prior card snapshotted before update");
  assert.equal(snapshots[0]!.frontmatter.id, oldCard.frontmatter.id, "snapshot is of the old card");
  assert.equal(storage.updated.length, 1, "one updateMemory call");
  assert.equal(storage.written.length, 0, "no writeMemory call (update path)");
});

// ──────────────────────────────────────────────────────────────────────────
// refresh — build failure → tagged failure, nothing persisted
// ──────────────────────────────────────────────────────────────────────────

test("refresh: build failure throws, nothing persisted (rule 34/44)", async () => {
  const storage = makeStubStorage();
  const ctx = makeContext({
    resolveStorage: async () => storage,
    buildCard: async () => ({
      ok: false,
      code: "scan_failed",
      detail: "permission denied",
    }) satisfies ArchitectureCardBuildResult,
  });
  await assert.rejects(
    () => handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx),
    (err: Error) => {
      assert.match(err.message, /scan_failed/, "error carries the build code");
      assert.doesNotMatch(
        err.message,
        /permission denied/,
        "raw detail must NOT reach the client (cursor review: raw build errors)",
      );
      return true;
    },
  );
  assert.equal(storage.written.length, 0, "nothing written on build failure");
  assert.equal(storage.updated.length, 0, "nothing updated on build failure");
});

test("refresh: invalid_root build failure surfaces the code", async () => {
  const ctx = makeContext({
    buildCard: async () => ({
      ok: false,
      code: "invalid_root",
      detail: "not a directory",
    }) satisfies ArchitectureCardBuildResult,
  });
  await assert.rejects(
    () => handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx),
    /invalid_root/,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// refresh — truncated card carries the truncation tag
// ──────────────────────────────────────────────────────────────────────────

test("refresh: truncated card carries 'truncated' tag in write options", async () => {
  const storage = makeStubStorage();
  const ctx = makeContext({
    resolveStorage: async () => storage,
    buildCard: async () => ({
      ok: true,
      card: {
        content: "# truncated card",
        generatedAt: NOW,
        byteSize: 4096,
        truncated: true,
      },
    }) satisfies ArchitectureCardBuildResult,
  });
  const result = await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "refresh") return;
  assert.equal(result.truncated, true);
  // Tags are passed in the writeMemory options and the stub stores them in frontmatter.
  assert.deepEqual(storage.written[0]!.options.tags, [ARCHITECTURE_CARD_TAG, "truncated"]);
  const written = storage.memories[storage.memories.length - 1];
  assert.ok(written?.frontmatter.tags?.includes("truncated"), "truncated tag present");
});

test("refresh: tombstone-blocked write surfaces refreshed:false + blocked reason (#1645)", async () => {
  // findArchitectureCardMemory filters non-active cards, so a blocked prior
  // card resolves to null and the refresh takes the first-card writeMemory
  // path. When that write is tombstone-blocked (#1579), the response must
  // report refreshed:false with a blocked reason — NOT refreshed:true, which
  // would hide the block from callers/UI.
  const base = makeStubStorage();
  const storage: StubStorage = {
    ...base,
    async writeSealedMemory(envelope, extras) {
      const result = await base.writeSealedMemory(envelope, extras);
      return { ...result, tombstoneBlocked: true, blockedBy: "tomb-arch-1" };
    },
  };
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  assert.equal(result.subcommand, "refresh");
  if (result.subcommand !== "refresh") return;
  assert.equal(result.refreshed, false, "a tombstone-blocked write is not refreshed");
  assert.equal(result.blockedReason, "tombstone-blocked", "blocked reason surfaced");
  assert.equal(result.blockedBy, "tomb-arch-1", "blocking tombstone id surfaced");
  assert.ok(result.memoryId, "pending_review memory still persisted with an id");
});

// ──────────────────────────────────────────────────────────────────────────
// get — truncation derived from content, not from a stale tag (cursor review)
// ──────────────────────────────────────────────────────────────────────────

test("get: truncation derived from content marker, surviving an update that left stale tags", async () => {
  // Seed a card that was originally truncated (tag present) but whose
  // content was later updated to a non-truncated body via updateMemory
  // (which does not refresh frontmatter tags).
  const storage = makeStubStorage([
    makeCardMemory({
      content: "# Fresh card — no truncation marker",
      frontmatter: { tags: [ARCHITECTURE_CARD_TAG, "truncated"] },
    }),
  ]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "get") return;
  assert.equal(result.found, true);
  assert.equal(result.card?.truncated, false, "content has no marker → false despite stale tag");
});

test("get: truncation true when content carries the marker", async () => {
  const storage = makeStubStorage([
    makeCardMemory({
      content: "# Card\n\n_… card truncated to fit size cap …_",
      frontmatter: { tags: [ARCHITECTURE_CARD_TAG] },
    }),
  ]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "get", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "get") return;
  assert.equal(result.found, true);
  assert.equal(result.card?.truncated, true, "content marker present → true");
});

// ──────────────────────────────────────────────────────────────────────────
// findArchitectureCardMemory — helper
// ──────────────────────────────────────────────────────────────────────────

test("findArchitectureCardMemory: returns null when no card in namespace", async () => {
  const storage = makeStubStorage([
    makeCardMemory({ frontmatter: { category: "decision" } }),
  ]);
  const result = await findArchitectureCardMemory(storage);
  assert.equal(result, null);
});

test("findArchitectureCardMemory: skips retired cards (non-active status)", async () => {
  const storage = makeStubStorage([
    makeCardMemory({ frontmatter: { status: "archived" } }),
  ]);
  const result = await findArchitectureCardMemory(storage);
  assert.equal(result, null, "archived card is not found");
});

test("findArchitectureCardMemory: returns the most recently updated card", async () => {
  const older = makeCardMemory({
    frontmatter: { id: "old", updated: "2026-01-01T00:00:00.000Z" },
  });
  const newer = makeCardMemory({
    frontmatter: { id: "new", updated: "2026-07-01T00:00:00.000Z" },
  });
  const storage = makeStubStorage([older, newer]);
  const result = await findArchitectureCardMemory(storage);
  assert.equal(result?.frontmatter.id, "new");
});

test("findArchitectureCardMemory: rejects tagged fact without cardKind marker (codex review)", async () => {
  // A user-created fact that merely happens to be tagged "architecture-card"
  // must NOT be treated as the managed card (would be overwritten on refresh).
  const storage = makeStubStorage([
    makeCardMemory({ frontmatter: { structuredAttributes: {} } }),
  ]);
  const result = await findArchitectureCardMemory(storage);
  assert.equal(result, null, "tagged fact without cardKind=architecture is not the managed card");
});

test("findArchitectureCardMemory: skips cards with archivedAt set (cursor review)", async () => {
  const storage = makeStubStorage([
    makeCardMemory({ frontmatter: { archivedAt: "2026-01-01T00:00:00.000Z" } }),
  ]);
  const result = await findArchitectureCardMemory(storage);
  assert.equal(result, null, "card with archivedAt is not found even without explicit status");
});

// ──────────────────────────────────────────────────────────────────────────
// Prove-fail-before: tools/list gate (rule 39)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Type-guarded extraction of tool names from a tools/list response.
 * Narrows with `in` checks so no inline cast is needed (no-fabricated-shape
 * rule). Returns the empty set on any shape the guard rejects.
 */
function extractToolNames(response: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof response !== "object" || response === null) return names;
  if (!("result" in response)) return names;
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return names;
  if (!("tools" in result)) return names;
  const tools = result.tools;
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
      names.add(tool.name);
    }
  }
  return names;
}

test("tools/list: engram.coding_architecture absent when gate off (byte-identical to main)", async () => {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true });
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = extractToolNames(response);
  assert.equal(names.has("engram.coding_architecture"), false, "tool must be absent when gate is off");
  assert.equal(names.has("remnic.coding_architecture"), false, "alias must be absent when gate is off");
});

test("tools/list: engram.coding_architecture present when gate on", async () => {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true, architectureCardVisible: true });
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = extractToolNames(response);
  assert.equal(names.has("engram.coding_architecture"), true, "tool must be advertised when gate is on");
  assert.equal(names.has("remnic.coding_architecture"), true, "alias must be advertised when gate is on");
});

// ──────────────────────────────────────────────────────────────────────────
// Registry fitness: coding_architecture operation is registered
// ──────────────────────────────────────────────────────────────────────────

test("registry: coding_architecture operation is registered through the boundary", () => {
  const op = getOperation("coding_architecture" as OperationName);
  assert.ok(op, "coding_architecture must be registered in the operation registry");
  assert.equal(op?.spec.name, "coding_architecture");
});

// ──────────────────────────────────────────────────────────────────────────
// Three surfaces → one service method (rule 22 spirit)
// ──────────────────────────────────────────────────────────────────────────

test("MCP surface: engram.coding_architecture dispatches through the boundary to service.codingArchitecture", async () => {
  const calls: ArchitectureSurfaceRequest[] = [];
  const service = {
    codingArchitecture(req: ArchitectureSurfaceRequest): Promise<unknown> {
      calls.push(req);
      return Promise.resolve({ subcommand: "get", found: false });
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { emitLegacyTools: true, architectureCardVisible: true });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.coding_architecture",
      arguments: { subcommand: "get", sessionKey: "s1" },
    },
  });
  assert.equal(calls.length, 1, "service.codingArchitecture called exactly once");
  assert.equal(calls[0]?.subcommand, "get");
});

test("MCP surface: remnic.coding_architecture alias dispatches identically", async () => {
  const calls: ArchitectureSurfaceRequest[] = [];
  const service = {
    codingArchitecture(req: ArchitectureSurfaceRequest): Promise<unknown> {
      calls.push(req);
      return Promise.resolve({ subcommand: "get", found: false });
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { emitLegacyTools: true, architectureCardVisible: true });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "remnic.coding_architecture",
      arguments: { subcommand: "get", sessionKey: "s1" },
    },
  });
  assert.equal(calls.length, 1, "service.codingArchitecture called exactly once via alias");
  assert.equal(calls[0]?.subcommand, "get");
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: sourceConnector provenance through updateMemory (codex finding)
// ──────────────────────────────────────────────────────────────────────────

test("refresh: updateMemory backfills sourceConnector when connector provided", async () => {
  // Seed an existing card WITHOUT sourceConnector (pre-provenance card).
  const storage = makeStubStorage([
    makeCardMemory({
      content: "# Old card — pre-provenance",
      frontmatter: { id: "old-card" },
    }),
  ]);
  const ctx = makeContext({
    resolveStorage: async () => storage,
    sourceConnector: "chatgpt",
  });
  await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  // updateMemory must have been called with sourceConnector in the options.
  assert.equal(storage.updated.length, 1, "updateMemory called once");
  assert.equal(
    storage.updated[0]!.options.sourceConnector,
    "chatgpt",
    "sourceConnector must reach updateMemory options",
  );
});

test("refresh: updateMemory omits sourceConnector when no connector in context", async () => {
  // Existing card, no connector in the context — updateMemory must still
  // succeed without breaking frontmatter.
  const storage = makeStubStorage([
    makeCardMemory({
      content: "# Existing card",
      frontmatter: { id: "existing-card" },
    }),
  ]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  assert.equal(storage.updated.length, 1, "updateMemory called once");
  assert.equal(
    storage.updated[0]!.options.sourceConnector,
    undefined,
    "no sourceConnector when context has none",
  );
});

test("refresh: updateMemory retains existing sourceConnector via frontmatter spread", async () => {
  // Existing card already HAS sourceConnector — updateMemory's frontmatter
  // spread preserves it even when the refresh call doesn't pass it again.
  const storage = makeStubStorage([
    makeCardMemory({
      content: "# Card with connector",
      frontmatter: { id: "connector-card", sourceConnector: "openclaw" },
    }),
  ]);
  const ctx = makeContext({ resolveStorage: async () => storage });
  const result = await handleCodingArchitecture({ subcommand: "refresh", sessionKey: "s1" }, ctx);
  if (result.subcommand !== "refresh") return;
  assert.equal(result.refreshed, true);
  // The card memory in storage must still have its sourceConnector.
  const card = storage.memories.find((m) => m.frontmatter.id === "connector-card");
  assert.equal(
    card?.frontmatter.sourceConnector,
    "openclaw",
    "existing sourceConnector preserved through updateMemory",
  );
});
