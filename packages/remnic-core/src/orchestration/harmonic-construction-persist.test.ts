import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import { deriveHarmonicRecords, type HarmonicConstructionInput } from "../harmonic-construction.js";
import { enqueueMergedTargetForHarmonicConstruction } from "./harmonic-construction-persist.js";

const storage = {
  dir: "/tmp/remnic-harmonic-coalesce",
  getMemoryByIdIncludingArchived: async () => null,
} as unknown as StorageManager;

function fact(cueAnchors: NonNullable<HarmonicConstructionInput["persistedFacts"][number]["cueAnchors"]>) {
  return {
    content: "placeholder — replaced by the committed body",
    category: "fact",
    tags: [],
    cueAnchors,
  };
}


test("two merges into one target coalesce to one harmonic entry: final body, unioned anchors (round N+9 C)", async () => {
  const map = new Map<string, {
    storage: StorageManager;
    facts: HarmonicConstructionInput["persistedFacts"];
  }>();
  await enqueueMergedTargetForHarmonicConstruction(
    map,
    storage,
    fact([{ type: "tool", value: "atlas release workflow" }]),
    "merge-target",
    "first cumulative body",
    "2026-08-22T10:00:00.000Z",
  );
  await enqueueMergedTargetForHarmonicConstruction(
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

test("a merged target's harmonic entry carries the committed record's entityRef and tags (#2807)", async () => {
  // The parity gate lets an incoming fact with NO entityRef merge into a
  // target that HAS one (only a differing non-undefined incoming entity
  // refuses), and incoming tags are a subset of the target's. The enqueue
  // used to stamp the incoming fact's fields onto the merged entry, so the
  // episode held the cumulative body while missing the target's committed
  // entity association and extra tags — and deriveHarmonicRecords skipped
  // the deterministic entity cue/topic linkage for the merged claims.
  const MERGED_BODY = "Billing service deploys run on Tuesdays at 09:00 UTC.";
  const committed: MemoryFile = {
    path: "/tmp/remnic-harmonic-merged/facts/2026-08-22/fact-target.md",
    frontmatter: {
      id: "fact-target",
      category: "fact",
      entityRef: "billing-service",
      tags: ["deploy", "infra"],
    } as unknown as MemoryFile["frontmatter"],
    content: MERGED_BODY,
  };
  const mergedStore = {
    dir: "/tmp/remnic-harmonic-merged",
    getMemoryByIdIncludingArchived: async (id: string) =>
      id === "fact-target" ? committed : null,
  } as unknown as StorageManager;
  const map = new Map<string, {
    storage: StorageManager;
    facts: HarmonicConstructionInput["persistedFacts"];
  }>();
  await enqueueMergedTargetForHarmonicConstruction(
    map,
    mergedStore,
    {
      content: "Deploys of the billing service run on Tuesdays.",
      category: "fact",
      tags: ["deploy"],
      cueAnchors: [{ type: "tool", value: "deploy runbook" }],
    },
    "fact-target",
    MERGED_BODY,
    "2026-08-22T12:00:00.000Z",
  );
  const entry = map.get(mergedStore.dir)!.facts[0]!;
  assert.equal(entry.content, MERGED_BODY, "the committed merged body is the entry body");
  assert.equal(entry.entityRef, "billing-service", "the committed entityRef survives the merge");
  assert.deepEqual(
    [...entry.tags].sort(),
    ["deploy", "infra"],
    "tags come from the committed target (a superset of the incoming subset)",
  );
  assert.deepEqual(
    entry.cueAnchors?.map((anchor) => anchor.value),
    ["deploy runbook"],
    "event-specific cue anchors still ride in from the incoming fact",
  );
  const records = deriveHarmonicRecords({
    sessionKey: "session-merged-entity",
    recordedAt: "2026-08-22T12:00:00.000Z",
    persistedFacts: [entry],
    entityMentions: [{ name: "Billing Service", type: "service" }],
  });
  const topic = records.nodes.find(
    (node) => node.kind === "topic" || node.kind === "project",
  );
  assert.ok(topic, "a topic node exists for the entity mention");
  assert.ok(
    topic.sourceMemoryIds?.includes("fact-target"),
    "the entity mention links to the merged target through the committed entityRef",
  );
  const entityAnchor = records.anchors.find(
    (anchor) => anchor.anchorType === "entity" && anchor.anchorValue === "billing-service",
  );
  assert.ok(
    entityAnchor !== undefined && entityAnchor.nodeRefs.includes(topic.nodeId),
    "the deterministic entity anchor references the topic node",
  );

  // Control: a reread that no longer matches the merged body (the record
  // advanced mid-flight) falls back to the incoming fact's own fields.
  const advancedStore = {
    dir: "/tmp/remnic-harmonic-advanced",
    getMemoryByIdIncludingArchived: async () => ({
      ...committed,
      content: "a newer writer's body",
    }) as MemoryFile,
  } as unknown as StorageManager;
  const advancedMap = new Map<string, {
    storage: StorageManager;
    facts: HarmonicConstructionInput["persistedFacts"];
  }>();
  await enqueueMergedTargetForHarmonicConstruction(
    advancedMap,
    advancedStore,
    {
      content: "incoming body",
      category: "fact",
      tags: ["deploy"],
    },
    "fact-target",
    MERGED_BODY,
    "2026-08-22T12:00:00.000Z",
  );
  const fallback = advancedMap.get(advancedStore.dir)!.facts[0]!;
  assert.equal(fallback.entityRef, undefined, "an advanced record never lends its metadata");
  assert.deepEqual(fallback.tags, ["deploy"]);
});
