import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_PAYLOAD_TEMPLATES } from "../injection-templates/index.js";
import { buildInjectionSuiteCorpusManifest } from "./corpus.js";
import {
  generateSuiteVariants,
  injectionSuiteVariantHash,
  validateInjectionSuiteVariant,
} from "./generator.js";
import { INJECTION_SUITE_FAMILIES } from "./types.js";

test("H5 has at least ten distinct templates per attack family", () => {
  for (const family of INJECTION_SUITE_FAMILIES) {
    const ids = INJECTION_PAYLOAD_TEMPLATES.filter(
      (template) => template.family === family,
    ).map((template) => template.templateId);
    assert.equal(new Set(ids).size, 10, family);
  }
});

test("base corpus freezes 100 safe cases per family with all canary mechanisms", () => {
  const variants = generateSuiteVariants(100, 71, "base");
  assert.equal(variants.length, 400);
  assert.deepEqual(
    [...new Set(variants.map((variant) => variant.canarySpec.type))].sort(),
    ["string", "tool", "url"],
  );
  for (const variant of variants) {
    assert.deepEqual(
      validateInjectionSuiteVariant(variant),
      [],
      variant.variantId,
    );
  }
  for (const family of INJECTION_SUITE_FAMILIES) {
    const counts = new Map<string, number>();
    for (const variant of variants.filter((entry) => entry.family === family)) {
      counts.set(variant.templateId, (counts.get(variant.templateId) ?? 0) + 1);
    }
    assert.deepEqual(
      [...counts.values()].sort((a, b) => a - b),
      Array(10).fill(10),
    );
  }
});

test("base, benign, and adaptive manifests are deterministic and separate", () => {
  const first = buildInjectionSuiteCorpusManifest("base", 100, 71);
  const second = buildInjectionSuiteCorpusManifest("base", 100, 71);
  const benign = buildInjectionSuiteCorpusManifest("benign", 10, 71);
  const adaptive = buildInjectionSuiteCorpusManifest("adaptive-r1", 100, 71);
  const adaptiveR2 = buildInjectionSuiteCorpusManifest("adaptive-r2", 100, 71);
  const adaptiveR3 = buildInjectionSuiteCorpusManifest("adaptive-r3", 100, 71);
  assert.deepEqual(first, second);
  assert.equal(first.scenarioCount, 400);
  assert.equal(benign.scenarioCount, 40);
  assert.equal(adaptive.scenarioCount, 400);
  assert.equal(adaptiveR2.scenarioCount, 400);
  assert.equal(adaptiveR3.scenarioCount, 400);
  assert.notEqual(first.manifestSha256, benign.manifestSha256);
  assert.notEqual(first.manifestSha256, adaptive.manifestSha256);
  assert.notEqual(adaptive.manifestSha256, adaptiveR2.manifestSha256);
  assert.notEqual(adaptiveR2.manifestSha256, adaptiveR3.manifestSha256);
  const baseVariants = generateSuiteVariants(3, 71, "base");
  const adaptiveVariants = generateSuiteVariants(3, 71, "adaptive-r1");
  assert.notDeepEqual(
    baseVariants.map(injectionSuiteVariantHash),
    adaptiveVariants.map(injectionSuiteVariantHash),
  );
  assert.ok(
    generateSuiteVariants(10, 71, "benign").every((variant) => variant.benign),
  );
});

test("committed corpus manifests match deterministic regeneration", async () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures/h5-injection",
  );
  for (const [directory, stage, count] of [
    ["base", "base", 100],
    ["benign-twins", "benign", 10],
    ["adaptive-r1", "adaptive-r1", 100],
    ["adaptive-r2", "adaptive-r2", 100],
    ["adaptive-r3", "adaptive-r3", 100],
  ] as const) {
    const committed = JSON.parse(
      await readFile(path.join(root, directory, "manifest.json"), "utf8"),
    );
    assert.deepEqual(
      committed,
      buildInjectionSuiteCorpusManifest(stage, count, 71),
    );
  }
});
