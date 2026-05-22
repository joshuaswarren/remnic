/**
 * Tests for the "reasoning_trace" MemoryCategory (#564 PR 1).
 *
 * Covers:
 * - Storage round-trip: a memory file written with category: reasoning_trace
 *   reads back with that category intact.
 * - Validator: VALID_MEMORY_CATEGORIES accepts the new value.
 * - Taxonomy resolver: `reasoning_trace` maps to the `reasoning-traces`
 *   taxonomy category.
 * - Zod / request schemas (memory store + extracted fact) accept the new
 *   value end-to-end.
 * - Routing engine validateRouteTarget accepts the new value.
 *
 * Out of scope (follow-up PRs): extraction prompt recognition, retrieval
 * path, benchmark coverage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager } from "../src/storage.ts";
import { VALID_MEMORY_CATEGORIES } from "../packages/remnic-core/src/config.js";
import {
  DEFAULT_TAXONOMY,
  resolveCategory,
} from "../packages/remnic-core/src/taxonomy/index.js";
import { validateRouteTarget } from "../packages/remnic-core/src/routing/engine.js";
import { ExtractedFactSchema } from "../packages/remnic-core/src/schemas.js";
import { memoryStoreRequestSchema } from "../packages/remnic-core/src/access-schema.js";
import type { MemoryCategory } from "../src/types.js";

describe("reasoning_trace category", () => {
  it("is assignable as a MemoryCategory value", () => {
    const category: MemoryCategory = "reasoning_trace";
    assert.equal(category, "reasoning_trace");
  });

  it("is present in VALID_MEMORY_CATEGORIES", () => {
    assert.ok(VALID_MEMORY_CATEGORIES.has("reasoning_trace"));
  });

  it("round-trips through StorageManager write/read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-reasoning-trace-"));
    try {
      const storage = new StorageManager(dir);
      const body = [
        "Problem: find the lowest-latency path between two services.",
        "Step 1: enumerate candidate routes.",
        "Step 2: measure round-trip time for each candidate.",
        "Step 3: pick the lowest observed p95 that also stayed below the SLO.",
        "Outcome: route-b won and we pinned it.",
      ].join("\n");

      const id = await storage.writeMemory("reasoning_trace", body, {
        source: "test",
        tags: ["reasoning", "routing-decision"],
        confidence: 0.9,
      });

      const memories = await storage.readAllMemories();
      const found = memories.find((m) => m.frontmatter.id === id);
      assert.ok(found, "written memory should be discoverable via readAllMemories");
      assert.equal(found.frontmatter.category, "reasoning_trace");
      assert.equal(found.frontmatter.source, "test");
      assert.deepEqual(found.frontmatter.tags, ["reasoning", "routing-decision"]);
      assert.ok(
        found.content.includes("route-b won"),
        "stored body should contain the full reasoning chain",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves through the default taxonomy to the reasoning-traces category", () => {
    const decision = resolveCategory(
      "Walk-through of how we chose route-b over route-a.",
      "reasoning_trace",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "reasoning-traces");
    assert.equal(decision.confidence, 1.0);
  });

  it("is accepted by validateRouteTarget", () => {
    const result = validateRouteTarget({ category: "reasoning_trace" });
    assert.equal(result.ok, true);
    assert.equal(result.target?.category, "reasoning_trace");
  });

  it("is accepted by ExtractedFactSchema (zod)", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "Tried A, fell back to B when A timed out; documented why.",
      confidence: 0.85,
      tags: ["reasoning"],
      reasoningTrace: {
        steps: [
          { order: 1, description: "Tried A and observed the timeout." },
          { order: 2, description: "Fell back to B and checked the result." },
        ],
        final_answer: "B was the reliable option.",
        observed_outcome: "The fallback completed successfully.",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("requires reasoningTrace payload for ExtractedFactSchema reasoning_trace facts", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "Tried A, fell back to B when A timed out; documented why.",
      confidence: 0.85,
      tags: ["reasoning"],
    });
    assert.equal(parsed.success, false);
  });

  it("is accepted by memoryStoreRequestSchema (zod)", () => {
    const parsed = memoryStoreRequestSchema.safeParse({
      content: "Reasoning chain for the latency investigation.",
      category: "reasoning_trace",
    });
    assert.equal(parsed.success, true);
  });
});
