/**
 * Issue #2829/#2780: truthful memory-store category input/output types
 * plus alias replay ergonomics.
 *
 *  - Input admits the canonical MemoryCategory values plus exactly four
 *    project-shaped compat aliases; near-misses reject.
 *  - The transform maps aliases to the canonical "fact" DURING parsing.
 *  - The inferred output stays the finite MemoryCategory union — the #2826
 *    double cast (runtime `project_state`, type says MemoryCategory) is gone.
 *  - The raw spelling is retained separately at the request boundary
 *    (`rawCategory`, minted only by the transform) for the response coercion
 *    note, idempotent-replay rebuild, and quarantine replay.
 *  - An idempotent replay recomputes the coercion note from the CURRENT
 *    request's spelling while the stored result is reused.
 *
 * The type-level assertions below are enforced by `tsc --noEmit` (tsconfig
 * includes src/**\/*.test.ts), so a regression to a cast or a widened union
 * fails check-types, not just this file's runtime asserts.
 *
 * All fixtures are synthetic — no real user data.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  categoryAliasCoercion,
  memoryStoreRequestSchema,
  reapplyCategoryCoercion,
  retainedCategoryAlias,
  validateRequest,
  type CategoryAliasCoercion,
  type MemoryStoreRequest,
  type SuggestionSubmitRequest,
} from "./access-schema.js";
import { memoryStoreOperation } from "./access-operations.js";
import { getOperation, operationRequiresAuthorizedNamespace } from "./access-boundary.js";
import { authorizationProbeNamespaces } from "./access-authorization-probe.js";
import {
  EngramAccessInputError,
  EngramAccessService,
  NamespaceNotWritableError,
  type EngramAccessWriteResponse,
} from "./access-service.js";
import { EngramMcpServer } from "./access-mcp.js";
import { Orchestrator } from "./orchestrator.js";
import type { CodingContext, PluginConfig } from "./types.js";
import {
  MEMORY_CATEGORY_NAMES,
  isMemoryCategory,
  sealedWriteToLegacyArgs,
  type SealedMemoryEnvelope,
} from "./write-envelope.js";
import { WriteQuarantineStore } from "./write-quarantine.js";

const ALIASES = ["project", "project_state", "project-state", "project_update"] as const;

const NEAR_MISSES = [
  "projection",
  "projectile",
  "project_typo",
  "project_states",
  "Project",
  "PROJECT_STATE",
  "Project-State",
  " fact",
  "facts",
  "Facts",
  "",
] as const;

// ---------------------------------------------------------------------------
// Schema: parse behavior
// ---------------------------------------------------------------------------

test("#2829 every compat alias parses to canonical fact and retains its spelling", () => {
  for (const alias of ALIASES) {
    const parsed = memoryStoreRequestSchema.parse({ content: "durable project fact", category: alias });
    assert.equal(parsed.category, "fact", `${alias} must canonicalize to fact`);
    assert.equal(parsed.rawCategory, alias, `${alias} must be retained on rawCategory`);
    assert.equal(isMemoryCategory(alias), false, `${alias} must not be a canonical category`);
  }
});

test("#2829 canonical categories parse unchanged with no retained spelling", () => {
  for (const canonical of MEMORY_CATEGORY_NAMES) {
    const parsed = memoryStoreRequestSchema.parse({ content: "durable fact", category: canonical });
    assert.equal(parsed.category, canonical);
    assert.equal(parsed.rawCategory, undefined, `${canonical} must not mint a rawCategory`);
  }
});

test("#2829 near-miss spellings reject and list the valid set (rule 51)", () => {
  for (const nearMiss of NEAR_MISSES) {
    const validation = validateRequest("memoryStore", { content: "durable fact", category: nearMiss });
    assert.equal(validation.success, false, `${JSON.stringify(nearMiss)} must reject`);
    if (validation.success) continue;
    const categoryDetail = validation.error.details.find((detail) => detail.field === "category");
    assert.ok(categoryDetail, `${JSON.stringify(nearMiss)} failure must name the category field`);
    assert.match(categoryDetail.message, /category must be one of:/, `${JSON.stringify(nearMiss)} must fail as a finite category`);
    assert.match(categoryDetail.message, /must be one of: fact,/, `${JSON.stringify(nearMiss)} failure must list valid options`);
  }
});

test("#2829 a client-supplied rawCategory never survives parsing", () => {
  const parsed = memoryStoreRequestSchema.parse({
    content: "durable fact",
    category: "preference",
    rawCategory: "project_state",
  });
  assert.equal(parsed.category, "preference");
  assert.equal(parsed.rawCategory, undefined, "rawCategory is transform-minted only — client values strip");
});

test("#2829 reapplyCategoryCoercion rebuilds or removes the stored note", () => {
  const stored: EngramAccessWriteResponse & { categoryCoercion?: CategoryAliasCoercion } = {
    schemaVersion: 1,
    operation: "memory_store",
    namespace: "default",
    dryRun: false,
    accepted: true,
    queued: false,
    status: "stored",
    categoryCoercion: { from: "project_state", to: "fact" },
  };
  const rebuilt = reapplyCategoryCoercion(stored, { from: "project-state", to: "fact" });
  assert.equal(rebuilt.categoryCoercion?.from, "project-state");
  assert.equal(rebuilt.categoryCoercion?.to, "fact");
  assert.equal(stored.categoryCoercion?.from, "project_state", "the stored note itself is untouched");

  const removed = reapplyCategoryCoercion(stored, undefined);
  assert.equal(removed.categoryCoercion, undefined, "a canonical replay must not report a coercion");
  assert.equal("categoryCoercion" in removed, false, "the key is absent, not undefined-valued");

  assert.deepEqual(reapplyCategoryCoercion({ status: "stored" } as EngramAccessWriteResponse, undefined), {
    status: "stored",
  });
});

test("#2829 retainedCategoryAlias reads the transform-minted spelling from a raw envelope", () => {
  assert.equal(retainedCategoryAlias({ category: "fact", rawCategory: "project_update" }), "project_update");
  assert.equal(retainedCategoryAlias({ category: "preference" }), undefined);
  assert.equal(retainedCategoryAlias({ rawCategory: "projection" }), undefined);
  assert.equal(retainedCategoryAlias(undefined), undefined);
  assert.equal(retainedCategoryAlias("string"), undefined);
  assert.deepEqual(categoryAliasCoercion("project"), { from: "project", to: "fact" });
  assert.equal(categoryAliasCoercion("fact"), undefined);
  assert.equal(categoryAliasCoercion(undefined), undefined);
});

test("#2889 retainedCategoryAlias recovers the spelling from a single-parse envelope's category", () => {
  // Single-parse callers (CLI store command, direct op.run) hand the op the
  // raw envelope: the alias sits on `category`, no `rawCategory` exists yet.
  assert.equal(retainedCategoryAlias({ content: "x", category: "project_state" }), "project_state");
  assert.equal(retainedCategoryAlias({ content: "x", category: "project-state" }), "project-state");
  // Canonical and near-miss categories never mint a retained spelling.
  assert.equal(retainedCategoryAlias({ content: "x", category: "fact" }), undefined);
  assert.equal(retainedCategoryAlias({ content: "x", category: "projection" }), undefined);
  assert.equal(retainedCategoryAlias({ content: "x" }), undefined);
  // A transform-minted rawCategory outranks the raw category spelling.
  assert.equal(retainedCategoryAlias({ category: "project_update", rawCategory: "project" }), "project");
});
// ---------------------------------------------------------------------------
// Type-level regressions (enforced by tsc via check-types)
// ---------------------------------------------------------------------------

test("#2829 type-level: output category stays a finite canonical union", () => {
  const canonical: NonNullable<MemoryStoreRequest["category"]> = "fact";
  // @ts-expect-error "project_state" is an input alias, never an output value
  const alias: NonNullable<MemoryStoreRequest["category"]> = "project_state";
  // @ts-expect-error arbitrary strings were never valid output
  const arbitrary: NonNullable<MemoryStoreRequest["category"]> = "projection";
  assert.equal(canonical, "fact");
  assert.equal(alias, "project_state");
  assert.equal(arbitrary, "projection");
});

test("#2829 type-level: wire input admits exactly the canonical set plus the aliases", () => {
  type WireCategory = z.input<typeof memoryStoreRequestSchema>["category"];
  const canonical: WireCategory = "reasoning_trace";
  const alias: WireCategory = "project-state";
  // @ts-expect-error near-misses are not wire input
  const nearMiss: WireCategory = "projection";
  assert.equal(canonical, "reasoning_trace");
  assert.equal(alias, "project-state");
  assert.equal(nearMiss, "projection");
});

// ---------------------------------------------------------------------------
// Operation boundary — the shared HTTP/MCP/CLI dispatch path
// ---------------------------------------------------------------------------

function captureService(): { service: EngramAccessService; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  const service = {
    memoryStore: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: true,
        accepted: true,
        queued: false,
        status: "validated",
      } satisfies EngramAccessWriteResponse;
    },
    suggestionSubmit: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        schemaVersion: 1,
        operation: "suggestion_submit",
        namespace: "default",
        dryRun: true,
        accepted: true,
        queued: true,
        status: "validated",
      } satisfies EngramAccessWriteResponse;
    },
  } as unknown as EngramAccessService;
  return { service, captured };
}

test("#2829 memory_store op canonicalizes the alias and retains the spelling at the boundary", async () => {
  const { service, captured } = captureService();
  const output = await memoryStoreOperation.run(
    { content: "durable project fact", category: "project_state" },
    { service },
  );
  assert.equal(output.result.status, "validated");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.category, "fact", "the service must receive the canonical category");
  assert.equal(captured[0]?.rawCategory, "project_state", "the boundary must retain the raw spelling");
});

test("#2829 memory_store op rejects a near-miss before the service runs", async () => {
  const { service, captured } = captureService();
  await assert.rejects(
    memoryStoreOperation.run({ content: "durable fact", category: "projection" }, { service }),
    (error: unknown) => {
      assert.ok(error instanceof EngramAccessInputError);
      assert.match(error.message, /Valid: .*fact/);
      return true;
    },
  );
  assert.equal(captured.length, 0);
});

test("#2829 suggestion_submit op uses the same canonical schema and retention", async () => {
  const op = getOperation("suggestion_submit");
  assert.ok(op, "suggestion_submit must be registered");
  const { service, captured } = captureService();
  await op.run(
    { content: "suggested project fact", category: "project_update", dryRun: true },
    { service },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.category, "fact");
  assert.equal(captured[0]?.rawCategory, "project_update");
  await assert.rejects(
    op.run({ content: "suggested fact", category: "projection" }, { service }),
    EngramAccessInputError,
  );
  assert.equal(captured.length, 1, "near-miss must not dispatch");
});

test("#2829 MCP memory_store dispatch carries the canonical category plus retained spelling", async () => {
  const { service, captured } = captureService();
  const server = new EngramMcpServer(service);
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.memory_store", arguments: { content: "durable project fact", category: "project-state", dryRun: true } },
  })) as { result?: { isError?: boolean } };
  assert.equal(response.result?.isError, false, "the alias must be accepted over MCP");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.category, "fact");
  assert.equal(captured[0]?.rawCategory, "project-state");
});

// ---------------------------------------------------------------------------
// Write surface — coercion note, persisted category, idempotent replay
// ---------------------------------------------------------------------------

interface PersistProbe {
  service: EngramAccessService;
  writes: Array<{ category: string; content: string }>;
}

function makePersistService(memoryDir: string): PersistProbe {
  const writes: Array<{ category: string; content: string }> = [];
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orch as unknown as {
    config: PluginConfig;
    _codingContextBySession: Map<string, CodingContext>;
  };
  internals.config = {
    namespacesEnabled: false,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    memoryDir,
  } as unknown as PluginConfig;
  internals._codingContextBySession = new Map();
  (orch as unknown as { getStorage: () => Promise<unknown> }).getStorage = async () => ({
    readAllMemories: async () => [],
    readAllColdMemories: async () => [],
    appendMemoryLifecycleEvents: async () => {},
    writeSealedMemory: async (envelope: SealedMemoryEnvelope) => {
      const { category, content } = sealedWriteToLegacyArgs(envelope);
      writes.push({ category, content });
      return { id: `mem-${writes.length}`, duplicateOf: undefined };
    },
    // The suggestion review-queue path re-reads and re-stamps the queued
    // memory (explicit-capture.ts queueExplicitCaptureForReview).
    getMemoryById: async (id: string) => ({ id, status: "active" }),
    writeMemoryFrontmatter: async () => {},
  });
  return { service: new EngramAccessService(orch), writes };
}

async function withPersistService(fn: (probe: PersistProbe) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-2829-"));
  try {
    await fn(makePersistService(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("#2829 an aliased write stores as fact and reports the coercion on the response", async () => {
  await withPersistService(async ({ service, writes }) => {
    const response = await service.memoryStore({
      content: "the deploy pipeline now runs on the staging cluster",
      category: "fact",
      confidence: 0.9,
      tags: [],
      rawCategory: "project_state",
    });
    assert.equal(response.status, "stored");
    assert.deepEqual(response.categoryCoercion, { from: "project_state", to: "fact" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.category, "fact", "the persisted memory must carry the canonical category");
  });
});

test("#2829 a canonical write reports no coercion", async () => {
  await withPersistService(async ({ service }) => {
    const response = await service.memoryStore({
      content: "plain canonical durable fact",
      category: "preference",
      confidence: 0.9,
      tags: [],
    });
    assert.equal(response.status, "stored");
    assert.equal(response.categoryCoercion, undefined);
    assert.equal("categoryCoercion" in response, false);
  });
});

test("#2829 a dry run still reports the coercion note", async () => {
  await withPersistService(async ({ service }) => {
    const response = await service.memoryStore({
      content: "dry run of an aliased write",
      category: "fact",
      confidence: 0.9,
      tags: [],
      dryRun: true,
      rawCategory: "project",
    });
    assert.equal(response.status, "validated");
    assert.deepEqual(response.categoryCoercion, { from: "project", to: "fact" });
  });
});

test("#2829 idempotent replay rebuilds the note from the CURRENT spelling and persists once", async () => {
  await withPersistService(async ({ service, writes }) => {
    const base = {
      content: "one idempotent aliased write",
      category: "fact" as const,
      confidence: 0.9,
      tags: [] as string[],
      idempotencyKey: "k-2829",
    };
    const first = await service.memoryStore({ ...base, rawCategory: "project_state" });
    assert.equal(first.status, "stored");
    assert.equal(first.idempotencyReplay, undefined);
    assert.equal(first.categoryCoercion?.from, "project_state");

    // Same key + equivalent (canonicalized) payload: a replay, not a conflict.
    const second = await service.memoryStore({ ...base, rawCategory: "project-state" });
    assert.equal(second.idempotencyReplay, true, "an alias and canonical spelling share one fingerprint");
    assert.equal(second.categoryCoercion?.from, "project-state", "the replay names THIS request's spelling");

    // A canonical replay must not inherit the stored note.
    const third = await service.memoryStore(base);
    assert.equal(third.idempotencyReplay, true);
    assert.equal("categoryCoercion" in third, false);

    assert.equal(writes.length, 1, "exactly one persist across all three requests");
  });
});

test("#2829 peek idempotency ignores the retained spelling", async () => {
  await withPersistService(async ({ service }) => {
    const withAlias = await service.peekMemoryStoreIdempotency({
      content: "peeked write",
      category: "fact",
      confidence: 0.9,
      tags: [],
      idempotencyKey: "peek-2829",
      rawCategory: "project_update",
    });
    const canonical = await service.peekMemoryStoreIdempotency({
      content: "peeked write",
      category: "fact",
      confidence: 0.9,
      tags: [],
      idempotencyKey: "peek-2829",
    });
    assert.deepEqual(withAlias, canonical, "the fingerprint must hash the canonical category only");
  });
});

test("#2889 single-pass op.run retains the alias through canonical validation and replay", async () => {
  // The CLI store command's path (PR #2866 review): the raw envelope carries
  // the alias on `category` and op.run performs the ONLY schema parse. The
  // boundary must still retain the spelling, and a same-key replay with a
  // different accepted spelling must report THIS caller's alias while the
  // stored result stays canonical and untouched.
  await withPersistService(async ({ service, writes }) => {
    const base = {
      content: "single-pass aliased idempotent write",
      confidence: 0.9,
      tags: [] as string[],
      idempotencyKey: "k-2889",
    };
    const first = await memoryStoreOperation.run(
      { ...base, category: "project_state" },
      { service },
    );
    assert.equal(first.result.status, "stored");
    assert.deepEqual(first.result.categoryCoercion, { from: "project_state", to: "fact" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.category, "fact", "the persisted memory stays canonical");

    const second = await memoryStoreOperation.run(
      { ...base, category: "project-state" },
      { service },
    );
    assert.equal(second.result.idempotencyReplay, true, "alias spellings share the canonical fingerprint");
    assert.deepEqual(second.result.categoryCoercion, { from: "project-state", to: "fact" });
    assert.equal(first.result.categoryCoercion?.from, "project_state", "the replay never mutates the stored note");
    assert.equal(writes.length, 1, "the replay persists nothing");

    const third = await memoryStoreOperation.run(
      { ...base, category: "fact" },
      { service },
    );
    assert.equal(third.result.idempotencyReplay, true);
    assert.equal("categoryCoercion" in third.result, false, "a canonical replay reports no coercion");
    assert.equal(writes.length, 1);
  });
});

test("#2889 a single-pass dry run reports the coercion note and persists nothing", async () => {
  await withPersistService(async ({ service, writes }) => {
    const output = await memoryStoreOperation.run(
      { content: "single-pass dry-run alias", category: "project_update", confidence: 0.9, tags: [], dryRun: true },
      { service },
    );
    assert.equal(output.result.status, "validated");
    assert.deepEqual(output.result.categoryCoercion, { from: "project_update", to: "fact" });
    assert.equal(writes.length, 0);
  });
});

test("#2889 suggestion_submit reports the coercion and queues the canonical category", async () => {
  await withPersistService(async ({ service, writes }) => {
    const aliased = await service.suggestionSubmit({
      content: "suggested aliased fact",
      category: "fact",
      confidence: 0.9,
      tags: [],
      rawCategory: "project_update",
    });
    assert.equal(aliased.status, "queued_for_review");
    assert.deepEqual(aliased.categoryCoercion, { from: "project_update", to: "fact" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.category, "fact", "the queued review memory stays canonical");

    const canonical = await service.suggestionSubmit({
      content: "suggested canonical fact",
      category: "preference",
      confidence: 0.9,
      tags: [],
    });
    assert.equal(canonical.status, "queued_for_review");
    assert.equal("categoryCoercion" in canonical, false, "a no-alias submit reports no coercion");
  });
});

// ---------------------------------------------------------------------------
// #2962 — direct service calls canonicalize accepted aliases at the split
// boundary instead of echoing them in an "unsupported category" 400
// ---------------------------------------------------------------------------

test("#2962 a direct service call canonicalizes an accepted alias instead of echoing it in a 400", async () => {
  // In-process consumers call the exported service API without a wire parse,
  // so an accepted alias arrives on `category` itself (PR #2866 review). The
  // split boundary must canonicalize it — same contract the wire schema
  // enforces for HTTP/MCP/CLI — and mint the retained spelling so the
  // response still reports the coercion note.
  await withPersistService(async ({ service, writes }) => {
    const aliased = await service.memoryStore({
      content: "direct in-process aliased write",
      category: "project",
      confidence: 0.9,
      tags: [],
    });
    assert.equal(aliased.status, "stored");
    assert.deepEqual(
      aliased.categoryCoercion,
      { from: "project", to: "fact" },
      "the retained raw spelling is still reported",
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.category, "fact", "the persisted memory stays canonical");

    const suggested = await service.suggestionSubmit({
      content: "direct in-process aliased suggestion",
      category: "project_update",
      confidence: 0.9,
      tags: [],
    });
    assert.equal(suggested.status, "queued_for_review");
    assert.deepEqual(suggested.categoryCoercion, { from: "project_update", to: "fact" });
    assert.equal(writes.length, 2);

    // A genuine near-miss changes nothing: it still rejects at the write
    // candidate with the attempted category echoed in the 400 detail.
    await assert.rejects(
      service.memoryStore({
        content: "a genuine near-miss must still reject",
        category: "projection",
        confidence: 0.9,
        tags: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof EngramAccessInputError);
        assert.match(error.message, /unsupported category: projection/);
        return true;
      },
    );
    assert.equal(writes.length, 2, "the near-miss persists nothing");
  });
});

// ---------------------------------------------------------------------------
// Quarantine — the parked payload keeps the raw spelling for replay
// ---------------------------------------------------------------------------

test("#2829 an ACL-rejected aliased write parks canonical + rawCategory for replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-2829-q-"));
  try {
    const orch = Object.create(Orchestrator.prototype) as Orchestrator;
    const internals = orch as unknown as {
      config: PluginConfig;
      _codingContextBySession: Map<string, CodingContext>;
    };
    internals.config = {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      memoryDir: dir,
    } as unknown as PluginConfig;
    internals._codingContextBySession = new Map();
    const service = new EngramAccessService(orch);

    await assert.rejects(
      service.memoryStore({
        content: "quarantined aliased write",
        category: "fact",
        confidence: 0.9,
        tags: [],
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        rawCategory: "project_state",
      } as Parameters<EngramAccessService["memoryStore"]>[0]),
      NamespaceNotWritableError,
    );

    const records = await new WriteQuarantineStore(dir).list();
    assert.equal(records.length, 1);
    const payload = records[0]?.payload as { category?: string; rawCategory?: string };
    assert.equal(payload.category, "fact", "parked category is the parsed canonical value");
    assert.equal(payload.rawCategory, "project_state", "parked payload retains the raw spelling for replay");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeService(persisted: { category?: string; writes?: number }, memoryDir?: string): EngramAccessService {
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orch as unknown as {
    config: PluginConfig;
    _codingContextBySession: Map<string, CodingContext>;
  };
  internals.config = {
    namespacesEnabled: false,
    defaultNamespace: "default",
    memoryDir: memoryDir ?? "/synthetic/remnic-2780",
  } as unknown as PluginConfig;
  internals._codingContextBySession = new Map();
  orch.getStorage = async () =>
    ({
      readAllMemories: async () => [],
      writeSealedMemory: async (envelope: SealedMemoryEnvelope) => {
        persisted.category = envelope.category;
        persisted.writes = (persisted.writes ?? 0) + 1;
        return { id: "mem-2780", tombstoneBlocked: false };
      },
      appendMemoryLifecycleEvents: async () => {},
    }) as never;
  return new EngramAccessService(orch);
}

test("project-shaped category aliases store as fact and the response reports the coercion (#2780)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-2780-"));
  try {
    const persisted: { category?: string } = {};
    const service = makeService(persisted);
    for (const alias of ALIASES) {
      const request = memoryStoreRequestSchema.parse({
        sessionKey: "s-2780",
        content: "durable synthetic memory content for alias tests",
        category: alias,
        confidence: 0.9,
      });
      const response = await service.memoryStore(request);
      assert.equal(response.status, "stored", `${alias} must store, not queue`);
      assert.equal(response.memoryId, "mem-2780");
      assert.equal(persisted.category, "fact", `${alias} must persist as the canonical "fact"`);
      assert.deepEqual(
        response.categoryCoercion,
        { from: alias, to: "fact" },
        `${alias} response must name the original value and the canonical category`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Authorization probe — nested preprocess/transform still requires namespace
// ---------------------------------------------------------------------------

test("#2829/#2866 transformed write schemas still require an authorized namespace", () => {
  assert.equal(
    memoryStoreRequestSchema instanceof z.ZodEffects,
    true,
    "memory_store schema is a category transform",
  );
  const suggestion = getOperation("suggestion_submit");
  assert.ok(suggestion);
  assert.ok(
    suggestion.spec.schema instanceof z.ZodEffects,
    "suggestion_submit wraps preprocess around the transform",
  );
  const inner = suggestion.spec.schema.innerType();
  assert.equal(
    inner instanceof z.ZodEffects,
    true,
    "one unwrap still lands on the category transform, not the object",
  );
  assert.equal(inner instanceof z.ZodObject, false);

  for (const operation of ["memory_store", "suggestion_submit"] as const) {
    assert.equal(
      operationRequiresAuthorizedNamespace(operation),
      true,
      `${operation} must stay namespace-required after the category transform`,
    );
    assert.deepEqual(
      authorizationProbeNamespaces([operation], undefined),
      [undefined],
      `${operation} probe must authorize the missing/default namespace`,
    );
    assert.deepEqual(
      authorizationProbeNamespaces([operation], "other"),
      ["other"],
      `${operation} probe must authorize the requested namespace`,
    );
  }
});

test("dryRun reports the coercion without persisting (#2780)", async () => {
  const persisted: { category?: string } = {};
  const service = makeService(persisted);
  const request = memoryStoreRequestSchema.parse({
    sessionKey: "s-2780-dry",
    content: "durable synthetic memory content for alias tests",
    category: "project_state",
    dryRun: true,
  });
  const response = await service.memoryStore(request);
  assert.equal(response.status, "validated");
  assert.deepEqual(response.categoryCoercion, { from: "project_state", to: "fact" });
  assert.equal(persisted.category, undefined, "dryRun must not persist");
});

test("valid categories pass through unchanged with no coercion note (#2780)", async () => {
  const persisted: { category?: string } = {};
  const service = makeService(persisted);
  for (const category of MEMORY_CATEGORY_NAMES) {
    const parsed = memoryStoreRequestSchema.parse({
      sessionKey: "s-2780-valid",
      content: "durable synthetic memory content for alias tests",
      category,
      dryRun: true,
    });
    assert.equal(parsed.category, category);
    const response = await service.memoryStore(parsed);
    assert.equal(response.status, "validated");
    assert.equal(
      response.categoryCoercion,
      undefined,
      `${category} is canonical and must never carry a coercion note`,
    );
  }
});

test("suggestion_submit coerces project-shaped aliases the same way (#2780)", async () => {
  const persisted: { category?: string } = {};
  const service = makeService(persisted);
  const request = memoryStoreRequestSchema.parse({
    sessionKey: "s-2780-sug",
    content: "durable synthetic suggestion content for alias tests",
    category: "project_update",
    dryRun: true,
  });
  const response = await service.suggestionSubmit(request);
  assert.equal(response.status, "validated");
  assert.deepEqual(response.categoryCoercion, { from: "project_update", to: "fact" });
});

test("idempotent replay recomputes the coercion note from the current request's spelling (#2780 fix B)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-2780-replay-"));
  try {
    const persisted: { category?: string; writes?: number } = {};
    const service = makeService(persisted, dir);
    const base = {
      sessionKey: "s-2780-replay",
      content: "durable synthetic memory content for alias tests",
      confidence: 0.9,
      idempotencyKey: "idem-2780",
    };
    const first = await service.memoryStore(memoryStoreRequestSchema.parse({ ...base, category: "project_state" }));
    assert.equal(first.status, "stored");
    assert.deepEqual(first.categoryCoercion, { from: "project_state", to: "fact" });
    assert.equal(persisted.writes, 1);

    const second = await service.memoryStore(memoryStoreRequestSchema.parse({ ...base, category: "project-state" }));
    assert.equal(second.idempotencyReplay, true, "same key + equivalent alias must replay, not re-store");
    assert.deepEqual(
      second.categoryCoercion,
      { from: "project-state", to: "fact" },
      "replay must name THIS request's spelling, not the stored one",
    );
    assert.equal(second.memoryId, first.memoryId, "replay must reuse the stored result id");
    assert.equal(persisted.writes, 1, "replay must not persist again");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MemoryStoreRequest and SuggestionSubmitRequest category are finite canonical unions (compile-time)", () => {
  const invalidMemoryStore: MemoryStoreRequest = {
    content: "durable synthetic content for type test",
    // @ts-expect-error "projection" near-miss is rejected at compile time
    category: "projection",
  };
  void invalidMemoryStore;

  const invalidSuggestion: SuggestionSubmitRequest = {
    content: "durable synthetic content for type test",
    // @ts-expect-error "projection" near-miss is rejected at compile time
    category: "projection",
  };
  void invalidSuggestion;

  const validMemoryStore: MemoryStoreRequest = {
    content: "durable synthetic content for type test",
    category: "fact",
  };
  assert.equal(validMemoryStore.category, "fact");
});
