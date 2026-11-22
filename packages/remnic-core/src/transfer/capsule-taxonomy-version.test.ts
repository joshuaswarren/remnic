/**
 * CapsuleTaxonomySchema schemaVersion registry — issue 3572.
 *
 * CapsuleBlockSchema accepted any non-empty string as the capsule's taxonomy
 * schemaVersion (the "free-form placeholder" hack). These tests pin the
 * contract: only taxonomy versions in the known registry parse, unknown ones
 * are refused with a message naming the known versions, and export with an
 * unknown override fails the same way.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeTempDir } from "../testing/tmp-dir.js";
import { exportCapsule } from "./capsule-export.js";
import { CAPSULE_TAXONOMY_VERSIONS, CapsuleBlockSchema } from "./types.js";

function baseBlock() {
  return {
    id: "capsule-test",
    version: "0.1.0",
    schemaVersion: CAPSULE_TAXONOMY_VERSIONS[0],
    parentCapsule: null,
    parent: null,
    description: "",
    retrievalPolicy: { tierWeights: {}, directAnswerEnabled: false },
    includes: {
      taxonomy: false,
      identityAnchors: false,
      peerProfiles: false,
      procedural: false,
    },
  };
}

test("known taxonomy versions parse", () => {
  for (const v of CAPSULE_TAXONOMY_VERSIONS) {
    const parsed = CapsuleBlockSchema.parse({ ...baseBlock(), schemaVersion: v });
    assert.equal(parsed.schemaVersion, v);
  }
});

test("unknown taxonomy versions are refused, naming the registry", () => {
  const result = CapsuleBlockSchema.safeParse({ ...baseBlock(), schemaVersion: "taxonomy-v9" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0].message, /taxonomy-v1/);
  }
  // Empty string stays refused too.
  assert.equal(CapsuleBlockSchema.safeParse({ ...baseBlock(), schemaVersion: "" }).success, false);
});

test("export refuses an unknown schemaVersion override", async () => {
  const root = await makeTempDir("cap-taxonomy-root-");
  const outDir = await makeTempDir("cap-taxonomy-out-");
  await assert.rejects(
    exportCapsule({
      name: "taxonomy-refusal-capsule",
      root,
      outDir,
      pluginVersion: "0.0.0-test",
      now: 1_700_000_000_000,
      capsule: { schemaVersion: "taxonomy-v9" },
    }),
    /taxonomy-v1/,
  );
});
