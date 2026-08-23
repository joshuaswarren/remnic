/**
 * #2780: remnic_memory_store category ergonomics.
 *
 * Fleet callers repeatedly guess project-shaped categories; the valid
 * category set contains no project-shaped name. The boundary schema admits
 * exactly the four spellings telemetry shows (project, project_state,
 * project-state, project_update); the write-surface funnel coerces them to
 * the canonical "fact" and the response reports the coercion so callers
 * learn. Every other spelling — including near-misses like projection or
 * project_typo — rejects with the full valid list plus a "use fact" hint.
 * An idempotent replay of an aliased write recomputes the coercion note
 * from the CURRENT request's spelling while the stored result is reused.
 *
 * All fixtures are synthetic — no real user data.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryStoreRequestSchema } from "./access-schema.js";
import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { SealedMemoryEnvelope } from "./write-envelope.js";
import { MEMORY_CATEGORY_NAMES } from "./write-envelope.js";
import type { CodingContext, PluginConfig } from "./types.js";

const PROJECT_ALIASES = ["project", "project_state", "project-state", "project_update"] as const;
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
    for (const alias of PROJECT_ALIASES) {
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

test("near-miss project spellings reject naming the valid set and the fact hint (#2780 fix A)", () => {
  // Only the four telemetry-attested spellings coerce; everything else —
  // including regex-shaped near-misses — must reject with the full list.
  for (const bad of [
    "vibe",
    "Project_State",
    "project state",
    "",
    "projection",
    "projectile",
    "project_typo",
    "projections",
  ]) {
    assert.throws(
      () =>
        memoryStoreRequestSchema.parse({
          sessionKey: "s-2780-bad",
          content: "durable synthetic memory content for alias tests",
          category: bad,
          dryRun: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error, `${JSON.stringify(bad)} must reject with an error`);
        assert.match(err.message, /must be one of: /, "error must name the valid categories");
        for (const valid of MEMORY_CATEGORY_NAMES) {
          assert.match(err.message, new RegExp(`\\b${valid}\\b`), `error must list ${valid}`);
        }
        assert.match(err.message, /for project state\/facts use/, "error must carry the hint");
        return true;
      },
      `${JSON.stringify(bad)} must be rejected, not coerced`,
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
