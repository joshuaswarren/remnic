import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { ExtractedFactSchema, ExtractionResultSchema } from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

test("parseConfig: extractionScopeClassificationEnabled defaults to true", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.extractionScopeClassificationEnabled, true);
});

test("parseConfig: extractionScopeClassificationEnabled can be explicitly disabled", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    extractionScopeClassificationEnabled: false,
  });
  assert.equal(cfg.extractionScopeClassificationEnabled, false);
});

test("parseConfig: extractionScopeClassificationEnabled coerces string 'false' to false", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    extractionScopeClassificationEnabled: "false" as any,
  });
  assert.equal(cfg.extractionScopeClassificationEnabled, false);
});

test("parseConfig: extractionScopeClassificationEnabled coerces string 'true' to true", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    extractionScopeClassificationEnabled: "true" as any,
  });
  assert.equal(cfg.extractionScopeClassificationEnabled, true);
});

// ---------------------------------------------------------------------------
// Schema validation: scope field on ExtractedFactSchema
// ---------------------------------------------------------------------------

test("ExtractedFactSchema: accepts scope='global'", () => {
  const result = ExtractedFactSchema.safeParse({
    category: "fact",
    content: "PostgreSQL 15 requires uuid-ossp for gen_random_uuid()",
    confidence: 0.95,
    tags: ["database"],
    scope: "global",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.scope, "global");
  }
});

test("ExtractedFactSchema: accepts scope='project'", () => {
  const result = ExtractedFactSchema.safeParse({
    category: "fact",
    content: "The deploy script is at scripts/deploy.sh",
    confidence: 0.9,
    tags: ["deployment"],
    scope: "project",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.scope, "project");
  }
});

test("ExtractedFactSchema: accepts scope=null (optional nullable)", () => {
  const result = ExtractedFactSchema.safeParse({
    category: "fact",
    content: "Some fact",
    confidence: 0.8,
    tags: [],
    scope: null,
  });
  assert.equal(result.success, true);
});

test("ExtractedFactSchema: accepts omitted scope (optional)", () => {
  const result = ExtractedFactSchema.safeParse({
    category: "fact",
    content: "Some fact",
    confidence: 0.8,
    tags: [],
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.scope, undefined);
  }
});

test("ExtractedFactSchema: rejects invalid scope value", () => {
  const result = ExtractedFactSchema.safeParse({
    category: "fact",
    content: "Some fact",
    confidence: 0.8,
    tags: [],
    scope: "workspace",
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Full ExtractionResultSchema with scope
// ---------------------------------------------------------------------------

test("ExtractionResultSchema: parses extraction result with mixed scopes", () => {
  const result = ExtractionResultSchema.safeParse({
    facts: [
      {
        category: "fact",
        content: "Magento 2.4.8 has a race condition in checkout",
        confidence: 0.95,
        tags: ["magento", "bug"],
        scope: "global",
      },
      {
        category: "fact",
        content: "The staging DB is at staging-db.internal",
        confidence: 0.9,
        tags: ["infrastructure"],
        scope: "project",
      },
      {
        category: "preference",
        content: "User prefers dark mode in all editors",
        confidence: 1.0,
        tags: ["preference"],
        scope: "global",
      },
    ],
    profileUpdates: [],
    entities: [],
    questions: [],
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.facts[0].scope, "global");
    assert.equal(result.data.facts[1].scope, "project");
    assert.equal(result.data.facts[2].scope, "global");
  }
});
