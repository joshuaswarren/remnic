/**
 * Tests for the MECE taxonomy knowledge directory (#366).
 *
 * Covers:
 * - Default taxonomy structure and MECE properties
 * - Resolver decision tree logic
 * - RESOLVER.md document generation
 * - Taxonomy loader (merge, validation, fallback)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_TAXONOMY,
  resolveCategory,
  generateResolverDocument,
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
} from "../packages/remnic-core/src/taxonomy/index.js";
import type {
  Taxonomy,
  TaxonomyCategory,
} from "../packages/remnic-core/src/taxonomy/types.js";
import type { MemoryCategory } from "../packages/remnic-core/src/types.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mece-taxonomy-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// All MemoryCategory values from types.ts
const ALL_MEMORY_CATEGORIES: MemoryCategory[] = [
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
];

// ── Default taxonomy structure ──────────────────────────────────────────────

describe("Default taxonomy", () => {
  it("has no duplicate IDs", () => {
    const ids = DEFAULT_TAXONOMY.categories.map((c) => c.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "Duplicate category IDs found");
  });

  it("is MECE: every MemoryCategory maps to exactly one taxonomy category (with priority tie-breaking)", () => {
    for (const mc of ALL_MEMORY_CATEGORIES) {
      const matches = DEFAULT_TAXONOMY.categories.filter((cat) =>
        cat.memoryCategories.includes(mc),
      );
      assert.ok(
        matches.length >= 1,
        `MemoryCategory "${mc}" is not mapped by any taxonomy category`,
      );
      // If multiple match, they must have distinct priorities so tie-breaking is deterministic
      if (matches.length > 1) {
        const priorities = matches.map((m) => m.priority);
        const uniquePriorities = new Set(priorities);
        assert.equal(
          priorities.length,
          uniquePriorities.size,
          `MemoryCategory "${mc}" has multiple taxonomy matches with the same priority`,
        );
      }
    }
  });

  it("version is a positive integer", () => {
    assert.ok(DEFAULT_TAXONOMY.version >= 1);
    assert.equal(DEFAULT_TAXONOMY.version, Math.floor(DEFAULT_TAXONOMY.version));
  });

  it("all categories have valid slugs", () => {
    for (const cat of DEFAULT_TAXONOMY.categories) {
      assert.doesNotThrow(() => validateSlug(cat.id), `Invalid slug: ${cat.id}`);
    }
  });

  it("passes full validation", () => {
    assert.doesNotThrow(() => validateTaxonomy(DEFAULT_TAXONOMY));
  });
});

// ── resolveCategory ─────────────────────────────────────────────────────────

describe("resolveCategory", () => {
  it("correction -> corrections category", () => {
    const decision = resolveCategory(
      "Actually, the population is 8 million, not 7.",
      "correction",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "corrections");
    assert.equal(decision.confidence, 1.0);
  });

  it("preference -> preferences category", () => {
    const decision = resolveCategory(
      "I prefer dark mode for all my editors",
      "preference",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "preferences");
    assert.equal(decision.confidence, 1.0);
  });

  it("entity -> entities category", () => {
    const decision = resolveCategory(
      "Acme Corp is a technology company based in NYC",
      "entity",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "entities");
    assert.equal(decision.confidence, 1.0);
  });

  it("fact -> facts category", () => {
    const decision = resolveCategory(
      "The speed of light is 299,792,458 m/s",
      "fact",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "facts");
    assert.equal(decision.confidence, 1.0);
  });

  it("moment -> moments category", () => {
    const decision = resolveCategory(
      "Today we launched version 2.0 of the product",
      "moment",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "moments");
    assert.equal(decision.confidence, 1.0);
  });

  it("procedure -> procedures category", () => {
    const decision = resolveCategory(
      "When shipping: run tests, open PR, wait for CI",
      "procedure",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "procedures");
    assert.equal(decision.confidence, 1.0);
  });

  it("ambiguous content uses priority tie-breaking", () => {
    // "relationship" maps to "entities", "commitment" maps to "decisions"
    // If both matched, priority would decide — but these each have a unique match
    const decision = resolveCategory(
      "relationship between two people",
      "relationship",
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "entities");
  });

  it("unknown category falls back to facts", () => {
    // Use a category string that isn't in any taxonomy mapping
    const decision = resolveCategory(
      "some random content",
      "unknown_cat" as MemoryCategory,
      DEFAULT_TAXONOMY,
    );
    assert.equal(decision.categoryId, "facts");
    assert.ok(decision.confidence < 1.0, "Fallback should have reduced confidence");
  });

  it("always includes alternatives", () => {
    const decision = resolveCategory(
      "I prefer TypeScript",
      "preference",
      DEFAULT_TAXONOMY,
    );
    assert.ok(decision.alternatives.length > 0, "Should include alternatives");
    // Alternatives should not include the selected category
    const altIds = decision.alternatives.map((a) => a.categoryId);
    assert.ok(!altIds.includes(decision.categoryId));
  });

  it("handles empty taxonomy gracefully", () => {
    const emptyTaxonomy: Taxonomy = { version: 1, categories: [] };
    const decision = resolveCategory("test", "fact", emptyTaxonomy);
    assert.equal(decision.categoryId, "facts");
    assert.equal(decision.confidence, 0);
  });
});

// ── RESOLVER.md generator ───────────────────────────────────────────────────

describe("generateResolverDocument", () => {
  it("output contains all categories ordered by priority", () => {
    const doc = generateResolverDocument(DEFAULT_TAXONOMY);
    const sorted = [...DEFAULT_TAXONOMY.categories].sort(
      (a, b) => a.priority - b.priority,
    );

    // Every category name should appear
    for (const cat of sorted) {
      assert.ok(
        doc.includes(cat.id),
        `RESOLVER.md missing category "${cat.id}"`,
      );
    }

    // Verify ordering: each step should appear before the next
    let lastIndex = -1;
    for (const cat of sorted) {
      const idx = doc.indexOf(`**${cat.id}/**`);
      assert.ok(idx > lastIndex, `Category "${cat.id}" appears out of order`);
      lastIndex = idx;
    }
  });

  it("includes the tie-breaking section", () => {
    const doc = generateResolverDocument(DEFAULT_TAXONOMY);
    assert.ok(doc.includes("Tie-breaking"));
    assert.ok(doc.includes("lowest priority number"));
  });

  it("includes taxonomy version", () => {
    const doc = generateResolverDocument(DEFAULT_TAXONOMY);
    assert.ok(doc.includes(`v${DEFAULT_TAXONOMY.version}`));
  });
});

// ── Taxonomy loader ─────────────────────────────────────────────────────────

describe("loadTaxonomy", () => {
  it("missing file returns defaults", async () => {
    const taxonomy = await loadTaxonomy(tmpDir);
    assert.deepStrictEqual(taxonomy.version, DEFAULT_TAXONOMY.version);
    assert.equal(taxonomy.categories.length, DEFAULT_TAXONOMY.categories.length);
  });

  it("merges custom taxonomy with defaults", async () => {
    const custom: Taxonomy = {
      version: 2,
      categories: [
        {
          id: "research",
          name: "Research",
          description: "Research notes and findings",
          filingRules: ["Research-related content"],
          priority: 45,
          memoryCategories: [],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify(custom),
    );

    const loaded = await loadTaxonomy(tmpDir);
    assert.equal(loaded.version, 2);
    // Should have all defaults plus the custom one
    assert.ok(loaded.categories.length > DEFAULT_TAXONOMY.categories.length);
    assert.ok(loaded.categories.some((c) => c.id === "research"));
    // Defaults should still be present
    assert.ok(loaded.categories.some((c) => c.id === "facts"));
  });

  it("user categories override defaults by ID", async () => {
    const custom: Taxonomy = {
      version: 1,
      categories: [
        {
          id: "facts",
          name: "Custom Facts",
          description: "Overridden facts category",
          filingRules: ["Custom filing rule"],
          priority: 55,
          memoryCategories: ["fact"],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify(custom),
    );

    const loaded = await loadTaxonomy(tmpDir);
    const facts = loaded.categories.find((c) => c.id === "facts");
    assert.ok(facts);
    assert.equal(facts.name, "Custom Facts");
    assert.equal(facts.priority, 55);
  });

  it("rejects invalid slug", async () => {
    const custom: Taxonomy = {
      version: 1,
      categories: [
        {
          id: "INVALID_SLUG",
          name: "Bad",
          description: "Bad category",
          filingRules: [],
          priority: 99,
          memoryCategories: [],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify(custom),
    );

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      (err: Error) => err.message.includes("invalid"),
    );
  });

  it("rejects non-string filingRules entries", async () => {
    const bad = {
      version: 1,
      categories: [
        {
          id: "research",
          name: "Research",
          description: "Research notes",
          filingRules: ["valid", null],
          priority: 45,
          memoryCategories: [],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(path.join(taxonomyDir, "taxonomy.json"), JSON.stringify(bad));

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      /filingRules\[1\] must be a non-empty string/,
    );
  });

  it("rejects non-string or unknown memoryCategories entries", async () => {
    const bad = {
      version: 1,
      categories: [
        {
          id: "facts",
          name: "Facts",
          description: "Overridden facts",
          filingRules: ["Facts"],
          priority: 10,
          memoryCategories: [123, "typo-category"],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(path.join(taxonomyDir, "taxonomy.json"), JSON.stringify(bad));

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      /memoryCategories\[0\] must be a non-empty string/,
    );

    bad.categories[0].memoryCategories = ["typo-category"];
    fs.writeFileSync(path.join(taxonomyDir, "taxonomy.json"), JSON.stringify(bad));
    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      /memoryCategories\[0\] is unknown: "typo-category"/,
    );
  });

  it("rejects malformed existing taxonomy file instead of falling back to defaults", async () => {
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify({ version: "bad", categories: "not-an-array" }),
    );

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      /version must be a number|categories must be an array/,
    );
  });

  it("rethrows non-ENOENT errors instead of falling back to defaults", async () => {
    // Create a taxonomy directory that is a file, not a directory, so readFile
    // on the nested path triggers ENOTDIR (not ENOENT).
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    // Write a plain file where a directory is expected
    fs.writeFileSync(taxonomyDir, "not a directory");

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        // Should be ENOTDIR or similar I/O error, NOT silently returning defaults
        return code !== "ENOENT";
      },
    );
  });

  it("rejects duplicate IDs", async () => {
    const custom: Taxonomy = {
      version: 1,
      categories: [
        {
          id: "alpha",
          name: "Alpha",
          description: "First",
          filingRules: [],
          priority: 10,
          memoryCategories: [],
        },
        {
          id: "alpha",
          name: "Alpha Dupe",
          description: "Duplicate",
          filingRules: [],
          priority: 20,
          memoryCategories: [],
        },
      ],
    };
    // Write just the custom categories (no merging defaults since both dupes are custom)
    // For this test, we need to bypass the merge. Let's validate directly.
    assert.throws(
      () => validateTaxonomy(custom),
      (err: Error) => err.message.includes("Duplicate"),
    );
  });
});

// ── saveTaxonomy ────────────────────────────────────────────────────────────

describe("saveTaxonomy", () => {
  it("saves and round-trips correctly", async () => {
    await saveTaxonomy(tmpDir, DEFAULT_TAXONOMY);
    const loaded = await loadTaxonomy(tmpDir);
    assert.equal(loaded.version, DEFAULT_TAXONOMY.version);
    assert.equal(loaded.categories.length, DEFAULT_TAXONOMY.categories.length);
  });

  it("rejects invalid taxonomy on save", async () => {
    const bad: Taxonomy = {
      version: 0,
      categories: [],
    };
    await assert.rejects(
      () => saveTaxonomy(tmpDir, bad),
      (err: Error) => err.message.includes("version"),
    );
  });
});

// ── validateSlug ────────────────────────────────────────────────────────────

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    assert.doesNotThrow(() => validateSlug("facts"));
    assert.doesNotThrow(() => validateSlug("my-custom-category"));
    assert.doesNotThrow(() => validateSlug("cat123"));
  });

  it("rejects empty slug", () => {
    assert.throws(() => validateSlug(""), /must not be empty/);
  });

  it("rejects slug over 32 chars", () => {
    assert.throws(() => validateSlug("a".repeat(33)), /exceeds 32/);
  });

  it("rejects slug starting with digit", () => {
    assert.throws(() => validateSlug("123abc"), /invalid/i);
  });

  it("rejects slug with uppercase", () => {
    assert.throws(() => validateSlug("MyCategory"), /invalid/i);
  });

  it("rejects slug with underscores", () => {
    assert.throws(() => validateSlug("my_category"), /invalid/i);
  });
});

// ── validateTaxonomy ───────────────────────────────────────────────────────

describe("validateTaxonomy priority validation", () => {
  function makeTaxonomyWithPriority(priority: number): Taxonomy {
    return {
      version: 1,
      categories: [
        {
          id: "test",
          name: "Test",
          description: "Test category",
          filingRules: ["test"],
          priority,
          memoryCategories: [],
        },
      ],
    };
  }

  it("rejects NaN priority", () => {
    assert.throws(
      () => validateTaxonomy(makeTaxonomyWithPriority(NaN)),
      /finite numeric priority/,
    );
  });

  it("rejects Infinity priority", () => {
    assert.throws(
      () => validateTaxonomy(makeTaxonomyWithPriority(Infinity)),
      /finite numeric priority/,
    );
  });

  it("rejects -Infinity priority", () => {
    assert.throws(
      () => validateTaxonomy(makeTaxonomyWithPriority(-Infinity)),
      /finite numeric priority/,
    );
  });

  it("accepts finite numeric priority", () => {
    assert.doesNotThrow(() => validateTaxonomy(makeTaxonomyWithPriority(50)));
    assert.doesNotThrow(() => validateTaxonomy(makeTaxonomyWithPriority(0)));
    assert.doesNotThrow(() => validateTaxonomy(makeTaxonomyWithPriority(-1)));
  });
});

// ── Config integration ──────────────────────────────────────────────────────

describe("Config integration", () => {
  it("parseConfig sets taxonomyEnabled to false by default", () => {
    const config = parseConfig({});
    assert.equal(config.taxonomyEnabled, false);
  });

  it("parseConfig sets taxonomyAutoGenResolver to true by default", () => {
    const config = parseConfig({});
    assert.equal(config.taxonomyAutoGenResolver, true);
  });

  it("parseConfig respects explicit values", () => {
    const config = parseConfig({
      taxonomyEnabled: true,
      taxonomyAutoGenResolver: false,
    });
    assert.equal(config.taxonomyEnabled, true);
    assert.equal(config.taxonomyAutoGenResolver, false);
  });

  // Finding 3: String booleans from CLI must be coerced (gotcha #36)
  it("parseConfig coerces string 'true' to boolean true for taxonomyEnabled", () => {
    const config = parseConfig({ taxonomyEnabled: "true" });
    assert.equal(config.taxonomyEnabled, true);
  });

  it("parseConfig coerces string 'false' to boolean false for taxonomyEnabled", () => {
    const config = parseConfig({ taxonomyEnabled: "false" });
    assert.equal(config.taxonomyEnabled, false);
  });

  it("parseConfig coerces string 'false' to boolean false for taxonomyAutoGenResolver", () => {
    const config = parseConfig({ taxonomyAutoGenResolver: "false" });
    assert.equal(config.taxonomyAutoGenResolver, false);
  });

  it("parseConfig coerces string 'true' to boolean true for taxonomyAutoGenResolver", () => {
    const config = parseConfig({ taxonomyAutoGenResolver: "true" });
    assert.equal(config.taxonomyAutoGenResolver, true);
  });

  it("parseConfig coerces '0'/'1' for taxonomy flags", () => {
    const config = parseConfig({ taxonomyEnabled: "1", taxonomyAutoGenResolver: "0" });
    assert.equal(config.taxonomyEnabled, true);
    assert.equal(config.taxonomyAutoGenResolver, false);
  });
});

// ── Duplicate ID detection in loadTaxonomy (Finding 2) ─────────────────────

describe("loadTaxonomy duplicate ID detection", () => {
  it("rejects duplicate category IDs in user taxonomy.json before map merge", async () => {
    const custom = {
      version: 1,
      categories: [
        {
          id: "my-cat",
          name: "My Cat",
          description: "First instance",
          filingRules: ["rule"],
          priority: 10,
          memoryCategories: [],
        },
        {
          id: "my-cat",
          name: "My Cat Dupe",
          description: "Duplicate instance",
          filingRules: ["rule2"],
          priority: 20,
          memoryCategories: [],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify(custom),
    );

    await assert.rejects(
      () => loadTaxonomy(tmpDir),
      (err: Error) => {
        return err.message.includes("Duplicate category IDs") && err.message.includes("my-cat");
      },
    );
  });

  it("allows unique category IDs in user taxonomy.json", async () => {
    const custom = {
      version: 1,
      categories: [
        {
          id: "alpha",
          name: "Alpha",
          description: "First",
          filingRules: ["rule"],
          priority: 10,
          memoryCategories: [],
        },
        {
          id: "beta",
          name: "Beta",
          description: "Second",
          filingRules: ["rule"],
          priority: 20,
          memoryCategories: [],
        },
      ],
    };
    const taxonomyDir = path.join(tmpDir, ".taxonomy");
    fs.mkdirSync(taxonomyDir, { recursive: true });
    fs.writeFileSync(
      path.join(taxonomyDir, "taxonomy.json"),
      JSON.stringify(custom),
    );

    const loaded = await loadTaxonomy(tmpDir);
    assert.ok(loaded.categories.some((c) => c.id === "alpha"));
    assert.ok(loaded.categories.some((c) => c.id === "beta"));
  });
});
