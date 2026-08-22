import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageManager } from "../index.js";
import { deriveHarmonicRecords, type HarmonicConstructionInput } from "../harmonic-construction.js";
import { enqueueMergedTargetForHarmonicConstruction } from "./harmonic-construction-persist.js";

const storage = { dir: "/tmp/remnic-harmonic-coalesce" } as StorageManager;

function fact(cueAnchors: NonNullable<HarmonicConstructionInput["persistedFacts"][number]["cueAnchors"]>) {
  return {
    content: "placeholder — replaced by the committed body",
    category: "fact",
    tags: [],
    cueAnchors,
  };
}

test("two merges into one target coalesce to one harmonic entry: final body, unioned anchors (round N+9 C)", () => {
  const map = new Map<string, {
    storage: StorageManager;
    facts: HarmonicConstructionInput["persistedFacts"];
  }>();
  enqueueMergedTargetForHarmonicConstruction(
    map,
    storage,
    fact([{ type: "tool", value: "atlas release workflow" }]),
    "merge-target",
    "first cumulative body",
    "2026-08-22T10:00:00.000Z",
  );
  enqueueMergedTargetForHarmonicConstruction(
    map,
    storage,
    fact([{ type: "entity", value: "Atlas PostgreSQL" }]),
    "merge-target",
    "second cumulative body",
    "2026-08-22T11:00:00.000Z",
  );
  const facts = map.get(storage.dir)!.facts;
  assert.equal(facts.length, 1, "one entry per target id, not one per merge");
  assert.equal(facts[0]!.content, "second cumulative body", "the FINAL committed body wins");
  assert.equal(facts[0]!.insertedAt, "2026-08-22T11:00:00.000Z");
  assert.deepEqual(
    facts[0]!.cueAnchors?.map((anchor) => anchor.value),
    ["atlas release workflow", "Atlas PostgreSQL"],
    "cue anchors UNION across merges",
  );
  // End-to-end contract: the derived episode holds exactly one body per
  // target (the final committed one) and anchors from BOTH merges survive.
  const records = deriveHarmonicRecords({
    sessionKey: "session-coalesce",
    recordedAt: "2026-08-22T11:00:00.000Z",
    persistedFacts: facts,
    entityMentions: [],
  });
  const episode = records.nodes.find((node) => node.kind === "episode");
  assert.ok(episode);
  assert.equal(
    (episode.summary.match(/cumulative body/g) ?? []).length,
    1,
    "the episode summary consumes ONE cumulative snapshot, not both",
  );
  assert.ok(episode.summary.includes("second"), "the snapshot is the FINAL committed body");
  const anchorValues = records.anchors.map((anchor) => anchor.anchorValue);
  assert.ok(
    anchorValues.includes("atlas release workflow") && anchorValues.includes("Atlas PostgreSQL"),
    "anchors from both merges reach the persisted anchor set",
  );
});
