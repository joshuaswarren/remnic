/**
 * Enrichment pipeline tests (issue #365).
 *
 * Covers: registry, importance tiering, pipeline orchestration, rate limiting,
 * audit trail, max candidates, disabled config, provider unavailability,
 * empty entity lists, and tag/sourceUrl preservation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
  appendAuditEntry,
  readAuditLog,
  defaultEnrichmentPipelineConfig,
} from "../src/enrichment.js";
import type {
  EnrichmentCandidate,
  EnrichmentPipelineConfig,
  EnrichmentProvider,
  EntityEnrichmentInput,
} from "../src/enrichment.js";
import type { ImportanceLevel } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_LOG = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeEntity(overrides: Partial<EntityEnrichmentInput> = {}): EntityEnrichmentInput {
  return {
    name: overrides.name ?? "TestEntity",
    type: overrides.type ?? "project",
    knownFacts: overrides.knownFacts ?? ["fact-1"],
    importanceLevel: overrides.importanceLevel ?? "normal",
  };
}

/** A mock provider that returns a fixed list of candidates. */
function makeMockProvider(
  id: string,
  costTier: "free" | "cheap" | "expensive" = "cheap",
  candidates: EnrichmentCandidate[] = [],
  available = true,
): EnrichmentProvider {
  return {
    id,
    costTier,
    async enrich() {
      return candidates;
    },
    async isAvailable() {
      return available;
    },
  };
}

function enabledConfig(
  overrides: Partial<EnrichmentPipelineConfig> = {},
): EnrichmentPipelineConfig {
  return {
    ...defaultEnrichmentPipelineConfig(),
    enabled: true,
    providers: [{ id: "mock", enabled: true, costTier: "cheap" }],
    importanceThresholds: {
      critical: ["mock"],
      high: ["mock"],
      normal: ["mock"],
      low: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

test("Registry: register and get provider", () => {
  const registry = new EnrichmentProviderRegistry();
  const provider = makeMockProvider("alpha");
  registry.register(provider);

  assert.equal(registry.get("alpha"), provider);
  assert.equal(registry.get("nonexistent"), undefined);
});

test("Registry: listEnabled filters to enabled providers", () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("a"));
  registry.register(makeMockProvider("b"));
  registry.register(makeMockProvider("c"));

  const config = enabledConfig({
    providers: [
      { id: "a", enabled: true, costTier: "free" },
      { id: "b", enabled: false, costTier: "cheap" },
      { id: "c", enabled: true, costTier: "expensive" },
    ],
  });

  const enabled = registry.listEnabled(config);
  const ids = enabled.map((p) => p.id).sort();
  assert.deepEqual(ids, ["a", "c"]);
});

// ---------------------------------------------------------------------------
// Importance tiering tests
// ---------------------------------------------------------------------------

test("Importance tiering: critical entities get expensive providers", () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("cheap-provider", "cheap"));
  registry.register(makeMockProvider("expensive-provider", "expensive"));

  const config = enabledConfig({
    providers: [
      { id: "cheap-provider", enabled: true, costTier: "cheap" },
      { id: "expensive-provider", enabled: true, costTier: "expensive" },
    ],
    importanceThresholds: {
      critical: ["cheap-provider", "expensive-provider"],
      high: ["cheap-provider"],
      normal: ["cheap-provider"],
      low: [],
    },
  });

  const criticalProviders = registry.getForImportance("critical", config);
  assert.equal(criticalProviders.length, 2);
  assert.ok(criticalProviders.some((p) => p.id === "expensive-provider"));

  const highProviders = registry.getForImportance("high", config);
  assert.equal(highProviders.length, 1);
  assert.equal(highProviders[0].id, "cheap-provider");
});

test("Importance tiering: low entities get no providers when low is empty", () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock"));

  const config = enabledConfig({
    importanceThresholds: {
      critical: ["mock"],
      high: ["mock"],
      normal: ["mock"],
      low: [],
    },
  });

  const providers = registry.getForImportance("low", config);
  assert.equal(providers.length, 0);
});

test("Importance tiering: trivial entities always get no providers", () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock"));

  const config = enabledConfig({
    importanceThresholds: {
      critical: ["mock"],
      high: ["mock"],
      normal: ["mock"],
      low: ["mock"],
    },
  });

  const providers = registry.getForImportance("trivial", config);
  assert.equal(providers.length, 0);
});

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

test("Pipeline: mock provider returns candidates and pipeline processes them", async () => {
  const candidates: EnrichmentCandidate[] = [
    { text: "Entity was founded in 2020", source: "mock", confidence: 0.8, category: "fact" },
    { text: "Entity has 50 employees", source: "mock", confidence: 0.7, category: "fact" },
  ];

  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock", "cheap", candidates));

  const config = enabledConfig();
  const entity = makeEntity();

  const results = await runEnrichmentPipeline([entity], registry, config, NOOP_LOG);
  assert.equal(results.length, 1);
  assert.equal(results[0].entityName, "TestEntity");
  assert.equal(results[0].provider, "mock");
  assert.equal(results[0].candidatesFound, 2);
  assert.equal(results[0].candidatesAccepted, 2);
  assert.equal(results[0].candidatesRejected, 0);
  assert.ok(results[0].elapsed >= 0);

  // acceptedCandidates must contain the actual candidate objects (issue #425 P1)
  assert.equal(results[0].acceptedCandidates.length, 2);
  assert.equal(results[0].acceptedCandidates[0].text, "Entity was founded in 2020");
  assert.equal(results[0].acceptedCandidates[1].text, "Entity has 50 employees");
});

test("Pipeline: rate limiting prevents calls beyond limit", async () => {
  let callCount = 0;
  const provider: EnrichmentProvider = {
    id: "limited",
    costTier: "cheap",
    async enrich() {
      callCount++;
      return [{ text: "fact", source: "limited", confidence: 0.5, category: "fact" }];
    },
    async isAvailable() {
      return true;
    },
  };

  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig({
    providers: [
      {
        id: "limited",
        enabled: true,
        costTier: "cheap",
        rateLimit: { maxPerMinute: 2, maxPerDay: 100 },
      },
    ],
    importanceThresholds: {
      critical: ["limited"],
      high: ["limited"],
      normal: ["limited"],
      low: ["limited"],
    },
  });

  // Create 5 entities — only 2 should get calls due to maxPerMinute=2
  const entities = Array.from({ length: 5 }, (_, i) =>
    makeEntity({ name: `Entity${i}`, importanceLevel: "normal" }),
  );

  const results = await runEnrichmentPipeline(entities, registry, config, NOOP_LOG);
  assert.equal(callCount, 2, "Only 2 provider calls should have been made");
  assert.equal(results.length, 5, "All 5 entities should have result entries");

  // 2 with actual results, 3 rate-limited (0 candidates)
  const withResults = results.filter((r) => r.candidatesFound > 0);
  const rateLimited = results.filter((r) => r.candidatesFound === 0);
  assert.equal(withResults.length, 2);
  assert.equal(rateLimited.length, 3);
});

test("Pipeline: rate limiting persists across pipeline invocations", async () => {
  let callCount = 0;
  const provider: EnrichmentProvider = {
    id: "persistent-limited",
    costTier: "cheap",
    async enrich() {
      callCount++;
      return [{ text: "fact", source: "persistent-limited", confidence: 0.5, category: "fact" }];
    },
    async isAvailable() {
      return true;
    },
  };

  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig({
    providers: [
      {
        id: "persistent-limited",
        enabled: true,
        costTier: "cheap",
        rateLimit: { maxPerMinute: 100, maxPerDay: 1 },
      },
    ],
    importanceThresholds: {
      critical: ["persistent-limited"],
      high: ["persistent-limited"],
      normal: ["persistent-limited"],
      low: ["persistent-limited"],
    },
  });

  const first = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);
  const second = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);

  assert.equal(callCount, 1);
  assert.equal(first[0].candidatesFound, 1);
  assert.equal(second[0].candidatesFound, 0);
  assert.equal(second[0].acceptedCandidates.length, 0);
});

test("Pipeline: max candidates trims excess", async () => {
  const candidates: EnrichmentCandidate[] = Array.from({ length: 30 }, (_, i) => ({
    text: `Fact ${i}`,
    source: "mock",
    confidence: 0.5,
    category: "fact" as const,
  }));

  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock", "cheap", candidates));

  const config = enabledConfig({ maxCandidatesPerEntity: 10 });
  const entity = makeEntity();

  const results = await runEnrichmentPipeline([entity], registry, config, NOOP_LOG);
  assert.equal(results[0].candidatesFound, 30);
  assert.equal(results[0].candidatesAccepted, 10);
  assert.equal(results[0].candidatesRejected, 20);

  // acceptedCandidates length must match accepted count
  assert.equal(results[0].acceptedCandidates.length, 10);
  assert.equal(results[0].acceptedCandidates[0].text, "Fact 0");
  assert.equal(results[0].acceptedCandidates[9].text, "Fact 9");
});

test("Pipeline: maxCandidatesPerEntity is shared across providers for one entity", async () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("provider-a", "cheap", [
    { text: "A fact", source: "provider-a", confidence: 0.5, category: "fact" },
  ]));
  registry.register(makeMockProvider("provider-b", "cheap", [
    { text: "B fact", source: "provider-b", confidence: 0.5, category: "fact" },
  ]));

  const config = enabledConfig({
    maxCandidatesPerEntity: 1,
    providers: [
      { id: "provider-a", enabled: true, costTier: "cheap" },
      { id: "provider-b", enabled: true, costTier: "cheap" },
    ],
    importanceThresholds: {
      critical: ["provider-a", "provider-b"],
      high: ["provider-a", "provider-b"],
      normal: ["provider-a", "provider-b"],
      low: ["provider-a", "provider-b"],
    },
  });

  const results = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);
  const acceptedCount = results.reduce(
    (sum, result) => sum + result.acceptedCandidates.length,
    0,
  );

  assert.equal(acceptedCount, 1);
  assert.deepEqual(
    results.flatMap((result) => result.acceptedCandidates.map((candidate) => candidate.text)),
    ["A fact"],
  );
});

test("Pipeline: maxCandidatesPerEntity = 0 rejects all candidates", async () => {
  const candidates: EnrichmentCandidate[] = Array.from({ length: 5 }, (_, i) => ({
    text: `Fact ${i}`,
    source: "mock",
    confidence: 0.5,
    category: "fact" as const,
  }));

  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock", "cheap", candidates));

  const config = enabledConfig({ maxCandidatesPerEntity: 0 });
  const entity = makeEntity();

  const results = await runEnrichmentPipeline([entity], registry, config, NOOP_LOG);
  assert.equal(results[0].candidatesFound, 5);
  assert.equal(results[0].candidatesAccepted, 0);
  assert.equal(results[0].candidatesRejected, 5);
  assert.equal(results[0].acceptedCandidates.length, 0);
});

test("Pipeline: disabled config returns empty results", async () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock"));

  const config = enabledConfig({ enabled: false });
  const results = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);
  assert.equal(results.length, 0);
});

test("Pipeline: provider unavailable is gracefully skipped", async () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock", "cheap", [], /* available */ false));

  const config = enabledConfig();
  const results = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);
  assert.equal(results.length, 1);
  assert.equal(results[0].candidatesFound, 0);
  assert.equal(results[0].candidatesAccepted, 0);
  assert.equal(results[0].acceptedCandidates.length, 0);
});

test("Pipeline: empty entities list returns empty results", async () => {
  const registry = new EnrichmentProviderRegistry();
  registry.register(makeMockProvider("mock"));

  const config = enabledConfig();
  const results = await runEnrichmentPipeline([], registry, config, NOOP_LOG);
  assert.equal(results.length, 0);
});

test("Pipeline: tags and sourceUrl preserved through pipeline", async () => {
  const candidates: EnrichmentCandidate[] = [
    {
      text: "Tagged fact",
      source: "will-be-overwritten",
      sourceUrl: "https://example.com/page",
      confidence: 0.9,
      category: "fact",
      tags: ["external", "verified"],
    },
  ];

  // Verify the candidates retain their tags and sourceUrl after pipeline processing
  let capturedCandidates: EnrichmentCandidate[] = [];
  const provider: EnrichmentProvider = {
    id: "mock",
    costTier: "cheap",
    async enrich() {
      // Return deep copies so we can verify the pipeline doesn't strip fields
      const results = candidates.map((c) => ({ ...c }));
      capturedCandidates = results;
      return results;
    },
    async isAvailable() {
      return true;
    },
  };

  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig();
  await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);

  // The pipeline tags candidates with the provider ID
  assert.equal(capturedCandidates[0].source, "mock");
  assert.equal(capturedCandidates[0].sourceUrl, "https://example.com/page");
  assert.deepEqual(capturedCandidates[0].tags, ["external", "verified"]);
});

// ---------------------------------------------------------------------------
// Audit tests
// ---------------------------------------------------------------------------

test("Audit: entries written and readable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "enrichment-audit-"));
  try {
    const entry1 = {
      timestamp: "2026-04-16T10:00:00.000Z",
      entityName: "Acme Corp",
      provider: "web-search",
      candidateText: "Acme Corp founded in 2015",
      sourceUrl: "https://example.com",
      accepted: true,
    };
    const entry2 = {
      timestamp: "2026-04-16T11:00:00.000Z",
      entityName: "Acme Corp",
      provider: "web-search",
      candidateText: "Acme Corp has 1000 employees",
      accepted: false,
      reason: "Low confidence",
    };

    await appendAuditEntry(tmpDir, entry1);
    await appendAuditEntry(tmpDir, entry2);

    const all = await readAuditLog(tmpDir);
    assert.equal(all.length, 2);
    assert.equal(all[0].entityName, "Acme Corp");
    assert.equal(all[0].accepted, true);
    assert.equal(all[1].accepted, false);
    assert.equal(all[1].reason, "Low confidence");

    // Filter by since
    const filtered = await readAuditLog(tmpDir, "2026-04-16T10:30:00.000Z");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].candidateText, "Acme Corp has 1000 employees");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Audit: since filtering compares timestamp instants", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "enrichment-audit-"));
  try {
    await appendAuditEntry(tmpDir, {
      timestamp: "2024-01-01T00:30:00+01:00",
      entityName: "Before Boundary",
      provider: "web-search",
      candidateText: "This happened before midnight UTC.",
      accepted: true,
    });
    await appendAuditEntry(tmpDir, {
      timestamp: "2024-01-01T00:00:00Z",
      entityName: "At Boundary",
      provider: "web-search",
      candidateText: "This happened at midnight UTC.",
      accepted: true,
    });
    await appendAuditEntry(tmpDir, {
      timestamp: "2024-01-01T01:00:00+01:00",
      entityName: "Also At Boundary",
      provider: "web-search",
      candidateText: "This also happened at midnight UTC.",
      accepted: true,
    });
    await appendAuditEntry(tmpDir, {
      timestamp: "2023-12-31T23:30:00-01:00",
      entityName: "After Boundary",
      provider: "web-search",
      candidateText: "This happened after midnight UTC despite the earlier local date.",
      accepted: true,
    });

    const filtered = await readAuditLog(tmpDir, "2024-01-01T00:00:00Z");

    assert.deepEqual(
      filtered.map((entry) => entry.entityName),
      ["At Boundary", "Also At Boundary", "After Boundary"],
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Audit: reading from nonexistent directory returns empty", async () => {
  const entries = await readAuditLog("/tmp/nonexistent-enrichment-audit-dir-" + Date.now());
  assert.equal(entries.length, 0);
});

// ---------------------------------------------------------------------------
// WebSearchProvider tests
// ---------------------------------------------------------------------------

test("WebSearchProvider: returns empty when no searchFn configured", async () => {
  const provider = new WebSearchProvider();
  assert.equal(provider.id, "web-search");
  assert.equal(provider.costTier, "cheap");
  assert.equal(await provider.isAvailable(), false);

  const results = await provider.enrich(makeEntity());
  assert.equal(results.length, 0);
});

test("WebSearchProvider: returns candidates from injected searchFn", async () => {
  const provider = new WebSearchProvider({
    searchFn: async (query: string) => [
      `Result for ${query}: snippet one`,
      `Result for ${query}: snippet two`,
    ],
  });

  assert.equal(await provider.isAvailable(), true);

  const results = await provider.enrich(makeEntity({ name: "Acme", type: "company" }));
  assert.equal(results.length, 2);
  assert.ok(results[0].text.includes("Acme company"));
  assert.equal(results[0].source, "web-search");
  assert.deepEqual(results[0].tags, ["web-search"]);
});

test("WebSearchProvider: propagates searchFn failures to the pipeline", async () => {
  const provider = new WebSearchProvider({
    searchFn: async () => {
      throw new Error("Network error");
    },
  });

  assert.equal(await provider.isAvailable(), true);

  await assert.rejects(
    provider.enrich(makeEntity()),
    /Network error/,
  );
});

test("Pipeline: WebSearchProvider backend failures enter provider error handling", async () => {
  const provider = new WebSearchProvider({
    searchFn: async () => {
      throw new Error("503");
    },
  });
  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig({
    providers: [{ id: "web-search", enabled: true, costTier: "cheap" }],
    importanceThresholds: {
      critical: ["web-search"],
      high: ["web-search"],
      normal: ["web-search"],
      low: ["web-search"],
    },
  });
  const errors: string[] = [];
  const log = {
    ...NOOP_LOG,
    error(message: string) {
      errors.push(message);
    },
  };

  const results = await runEnrichmentPipeline(
    [makeEntity({ name: "Maya", importanceLevel: "high" })],
    registry,
    config,
    log,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].provider, "web-search");
  assert.equal(results[0].candidatesFound, 0);
  assert.equal(results[0].candidatesAccepted, 0);
  assert.equal(results[0].acceptedCandidates.length, 0);
  assert.match(errors[0] ?? "", /provider web-search failed for Maya: 503/);
});

// ---------------------------------------------------------------------------
// Default config tests
// ---------------------------------------------------------------------------

test("defaultEnrichmentPipelineConfig returns disabled config", () => {
  const config = defaultEnrichmentPipelineConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.providers.length, 0);
  assert.equal(config.maxCandidatesPerEntity, 20);
  assert.equal(config.autoEnrichOnCreate, false);
  assert.equal(config.scheduleIntervalMs, 3_600_000);
  assert.deepEqual(config.importanceThresholds.critical, []);
  assert.deepEqual(config.importanceThresholds.low, []);
});

// ---------------------------------------------------------------------------
// Provider error handling
// ---------------------------------------------------------------------------

test("Pipeline: failed provider calls count toward rate-limit buckets", async () => {
  // PR #425 review finding 2: if a provider throws after sending the request,
  // the attempt must still be counted so the rate limiter stays accurate.
  let callCount = 0;
  const provider: EnrichmentProvider = {
    id: "flaky",
    costTier: "cheap",
    async enrich() {
      callCount++;
      throw new Error("Transient failure");
    },
    async isAvailable() {
      return true;
    },
  };

  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig({
    providers: [
      {
        id: "flaky",
        enabled: true,
        costTier: "cheap",
        rateLimit: { maxPerMinute: 2, maxPerDay: 100 },
      },
    ],
    importanceThresholds: {
      critical: ["flaky"],
      high: ["flaky"],
      normal: ["flaky"],
      low: ["flaky"],
    },
  });

  // 5 entities but maxPerMinute=2 — even though all calls fail, only 2
  // should be attempted because failures count toward the rate limit.
  const entities = Array.from({ length: 5 }, (_, i) =>
    makeEntity({ name: `Entity${i}`, importanceLevel: "normal" }),
  );

  const results = await runEnrichmentPipeline(entities, registry, config, NOOP_LOG);
  assert.equal(callCount, 2, "Only 2 provider calls should have been made (failures count toward rate limit)");
  assert.equal(results.length, 5, "All 5 entities should have result entries");

  // All 5 should report 0 candidates (2 failed, 3 rate-limited)
  for (const r of results) {
    assert.equal(r.candidatesFound, 0);
  }
});

test("Pipeline: provider that throws is gracefully skipped", async () => {
  const provider: EnrichmentProvider = {
    id: "mock",
    costTier: "cheap",
    async enrich() {
      throw new Error("Provider crashed");
    },
    async isAvailable() {
      return true;
    },
  };

  const registry = new EnrichmentProviderRegistry();
  registry.register(provider);

  const config = enabledConfig();
  const results = await runEnrichmentPipeline([makeEntity()], registry, config, NOOP_LOG);
  assert.equal(results.length, 1);
  assert.equal(results[0].candidatesFound, 0);
  assert.equal(results[0].candidatesAccepted, 0);
  assert.equal(results[0].acceptedCandidates.length, 0);
});
