import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPSULE_ID_PATTERN,
  CapsuleBlockSchema,
  ExportBundleV2Schema,
  ExportManifestV1Schema,
  ExportManifestV2Schema,
  parseExportBundle,
  parseExportManifest,
} from "@remnic/core/transfer/types";

function makeV1Manifest() {
  return {
    format: "openclaw-engram-export" as const,
    schemaVersion: 1 as const,
    createdAt: new Date("2026-04-25T00:00:00.000Z").toISOString(),
    pluginVersion: "9.3.194",
    includesTranscripts: false,
    files: [{ path: "profile.md", sha256: "a".repeat(64), bytes: 12 }],
  };
}

function makeCapsuleBlock() {
  return {
    id: "research-2026",
    version: "1.0.0",
    schemaVersion: "taxonomy-v1",
    parentCapsule: null as string | null,
    description: "Research capsule for 2026 planning",
    retrievalPolicy: {
      tierWeights: { bm25: 1.0, vector: 0.8, graph: 0.5 },
      directAnswerEnabled: true,
    },
    includes: {
      taxonomy: true,
      identityAnchors: false,
      peerProfiles: false,
      procedural: true,
    },
  };
}

function makeV2Manifest() {
  const v1 = makeV1Manifest();
  return {
    ...v1,
    schemaVersion: 2 as const,
    capsule: makeCapsuleBlock(),
  };
}

test("V1 manifest still parses unchanged via direct schema", () => {
  const m = ExportManifestV1Schema.parse(makeV1Manifest());
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.files.length, 1);
});

test("V1 manifest is recognized by parseExportManifest with capsule null", () => {
  const result = parseExportManifest(makeV1Manifest());
  assert.equal(result.capsuleVersion, 1);
  assert.equal(result.capsule, null);
  assert.equal(result.manifest.schemaVersion, 1);
});

test("V2 manifest with full capsule block round-trips", () => {
  const input = makeV2Manifest();
  const parsed = ExportManifestV2Schema.parse(input);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.capsule.id, "research-2026");
  assert.equal(parsed.capsule.version, "1.0.0");
  assert.equal(parsed.capsule.parentCapsule, null);
  assert.deepEqual(parsed.capsule.includes, {
    taxonomy: true,
    identityAnchors: false,
    peerProfiles: false,
    procedural: true,
  });
  assert.equal(parsed.capsule.retrievalPolicy.tierWeights.bm25, 1.0);
  assert.equal(parsed.capsule.retrievalPolicy.directAnswerEnabled, true);

  // Re-serialize and re-parse to exercise round-trip stability.
  const reparsed = ExportManifestV2Schema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed, parsed);
});

test("parseExportManifest dispatches V2 and exposes capsule", () => {
  const result = parseExportManifest(makeV2Manifest());
  assert.equal(result.capsuleVersion, 2);
  assert.ok(result.capsule);
  assert.equal(result.capsule?.id, "research-2026");
});

test("parseExportBundle accepts V1 and V2 bundles", () => {
  const v1Bundle = {
    manifest: makeV1Manifest(),
    records: [{ path: "profile.md", content: "hello" }],
  };
  const r1 = parseExportBundle(v1Bundle);
  assert.equal(r1.capsuleVersion, 1);
  assert.equal(r1.capsule, null);

  const v2Bundle = {
    manifest: makeV2Manifest(),
    records: [{ path: "profile.md", content: "hello" }],
  };
  const r2 = parseExportBundle(v2Bundle);
  assert.equal(r2.capsuleVersion, 2);
  assert.equal(r2.capsule?.id, "research-2026");

  // Ensure V2 bundle schema validates directly too.
  const direct = ExportBundleV2Schema.parse(v2Bundle);
  assert.equal(direct.manifest.capsule.id, "research-2026");
});

test("V2 manifest with malformed capsule.id (spaces) is rejected", () => {
  const bad = makeV2Manifest();
  bad.capsule.id = "has spaces";
  assert.throws(() => ExportManifestV2Schema.parse(bad), /capsule\.id/);
});

test("V2 manifest with leading dash in capsule.id is rejected", () => {
  const bad = makeV2Manifest();
  bad.capsule.id = "-leading-dash";
  assert.throws(() => ExportManifestV2Schema.parse(bad), /capsule\.id/);
});

test("V2 manifest with consecutive dashes in capsule.id is rejected", () => {
  const bad = makeV2Manifest();
  bad.capsule.id = "double--dash";
  assert.throws(() => ExportManifestV2Schema.parse(bad), /capsule\.id/);
});

test("CAPSULE_ID_PATTERN accepts canonical ids and rejects bad ones", () => {
  assert.match("a", CAPSULE_ID_PATTERN);
  assert.match("a1", CAPSULE_ID_PATTERN);
  assert.match("research-2026", CAPSULE_ID_PATTERN);
  assert.match("ABC-xyz-123", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("-x", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("x-", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("a b", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("a--b", CAPSULE_ID_PATTERN);
  assert.doesNotMatch("a/b", CAPSULE_ID_PATTERN);
});

test("V2 manifest with missing required capsule fields is rejected", () => {
  const baseV2 = makeV2Manifest();

  // Missing capsule entirely
  const noCapsule: Record<string, unknown> = { ...baseV2 };
  delete noCapsule.capsule;
  assert.throws(() => ExportManifestV2Schema.parse(noCapsule));

  // Missing capsule.version
  const noVersion = JSON.parse(JSON.stringify(baseV2));
  delete noVersion.capsule.version;
  assert.throws(() => ExportManifestV2Schema.parse(noVersion));

  // Missing capsule.schemaVersion
  const noSchemaVersion = JSON.parse(JSON.stringify(baseV2));
  delete noSchemaVersion.capsule.schemaVersion;
  assert.throws(() => ExportManifestV2Schema.parse(noSchemaVersion));

  // Missing capsule.retrievalPolicy
  const noPolicy = JSON.parse(JSON.stringify(baseV2));
  delete noPolicy.capsule.retrievalPolicy;
  assert.throws(() => ExportManifestV2Schema.parse(noPolicy));

  // Missing capsule.includes
  const noIncludes = JSON.parse(JSON.stringify(baseV2));
  delete noIncludes.capsule.includes;
  assert.throws(() => ExportManifestV2Schema.parse(noIncludes));

  // Missing one of the required includes booleans
  const partialIncludes = JSON.parse(JSON.stringify(baseV2));
  delete partialIncludes.capsule.includes.procedural;
  assert.throws(() => ExportManifestV2Schema.parse(partialIncludes));

  // Missing parentCapsule (must be explicit null, not undefined)
  const noParent = JSON.parse(JSON.stringify(baseV2));
  delete noParent.capsule.parentCapsule;
  assert.throws(() => ExportManifestV2Schema.parse(noParent));
});

test("V2 manifest rejects invalid semver in capsule.version", () => {
  const bad = makeV2Manifest();
  bad.capsule.version = "v1";
  assert.throws(() => ExportManifestV2Schema.parse(bad), /capsule\.version/);
});

test("V2 manifest rejects negative tier weights", () => {
  const bad = makeV2Manifest();
  bad.capsule.retrievalPolicy.tierWeights.bm25 = -0.5;
  assert.throws(() => ExportManifestV2Schema.parse(bad));
});

test("V2 capsule allows non-null parentCapsule for forks", () => {
  const forked = makeV2Manifest();
  forked.capsule.parentCapsule = "research-2025";
  const parsed = ExportManifestV2Schema.parse(forked);
  assert.equal(parsed.capsule.parentCapsule, "research-2025");
});

test("CapsuleBlockSchema can be reused independently", () => {
  const block = CapsuleBlockSchema.parse(makeCapsuleBlock());
  assert.equal(block.id, "research-2026");
});

test("parseExportManifest with unknown schemaVersion falls back gracefully", () => {
  // A manifest without a schemaVersion field still parses if it matches V1
  // shape; this preserves leniency for hand-authored payloads.
  const looseV1 = { ...makeV1Manifest() } as Record<string, unknown>;
  // Force schemaVersion to an unknown value that wouldn't match either schema.
  looseV1.schemaVersion = 99;
  assert.throws(() => parseExportManifest(looseV1));
});
