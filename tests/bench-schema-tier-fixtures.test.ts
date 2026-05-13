import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_TIER_FIXTURE,
  SCHEMA_TIER_SMOKE_FIXTURE,
  buildSchemaTierFixture,
  buildSchemaTierSmokeFixture,
} from "../packages/bench/src/fixtures/schema-tiers/index.js";

test("schema tier fixture keeps the same page ids across clean and dirty corpora", () => {
  const cleanIds = SCHEMA_TIER_FIXTURE.clean.pages.map((page) => page.id).sort();
  const dirtyIds = SCHEMA_TIER_FIXTURE.dirty.pages.map((page) => page.id).sort();

  assert.deepEqual(cleanIds, dirtyIds);
});

test("schema tier fixture models real schema degradation in the dirty corpus", () => {
  const cleanLaunch = SCHEMA_TIER_FIXTURE.clean.pages.find((page) => page.id === "alex-project-atlas-launch");
  const dirtyLaunch = SCHEMA_TIER_FIXTURE.dirty.pages.find((page) => page.id === "alex-project-atlas-launch");
  const dirtyTraining = SCHEMA_TIER_FIXTURE.dirty.pages.find((page) => page.id === "morgan-q3-training-plan");

  assert.ok(cleanLaunch);
  assert.ok(dirtyLaunch);
  assert.ok(dirtyTraining);

  assert.equal(cleanLaunch.frontmatter.type, "project");
  assert.equal(dirtyLaunch.frontmatter.type, undefined);
  assert.match(dirtyLaunch.seeAlso[0] ?? "", /Retro/);
  assert.deepEqual(dirtyLaunch.dirtySignals, [
    "missing-frontmatter-type",
    "dropped-backlink",
    "backlink-casing-drift",
    "title-casing-drift",
  ]);
  assert.equal(dirtyTraining.frontmatter.created, "2025-08-03T07:00:00.000Z");
  assert.deepEqual(dirtyTraining.dirtySignals, ["stale-created-date", "stale-timeline-date"]);
});

test("schema tier fixture includes personalization, temporal, and abstention coverage", () => {
  assert.equal(SCHEMA_TIER_FIXTURE.personalizationCases.length, 5);
  assert.equal(SCHEMA_TIER_FIXTURE.temporalCases.length, 2);
  assert.equal(SCHEMA_TIER_FIXTURE.abstentionCases.length, 3);

  assert.equal(
    SCHEMA_TIER_FIXTURE.personalizationCases[0]?.expectedNamespace,
    "alex/work",
  );
  assert.deepEqual(
    SCHEMA_TIER_FIXTURE.temporalCases[0]?.window,
    {
      start: "2026-07-16T00:00:00.000Z",
      end: "2026-07-17T00:00:00.000Z",
    },
  );
  assert.equal(
    SCHEMA_TIER_FIXTURE.abstentionCases[1]?.reason,
    "cross_tenant",
  );
  assert.equal(
    SCHEMA_TIER_FIXTURE.personalizationCases.find((item) => item.id === "taylor-commerce-checkout-boundary")?.expectedPageIds[0],
    "taylor-commerce-boundaries",
  );
});

test("schema tier fixture builders are deterministic for the same seed", () => {
  assert.deepEqual(buildSchemaTierFixture(448), buildSchemaTierFixture(448));
  assert.deepEqual(buildSchemaTierSmokeFixture(448), buildSchemaTierSmokeFixture(448));
});

test("schema tier fixture builders return deep-cloned retrieval cases", () => {
  const first = buildSchemaTierFixture(448);
  const second = buildSchemaTierFixture(448);

  first.personalizationCases[0]?.expectedPageIds.push("mutated-page");
  if (first.temporalCases[0]) {
    first.temporalCases[0].window.start = "1999-01-01T00:00:00.000Z";
  }
  if (first.abstentionCases[0]) {
    first.abstentionCases[0].reason = "cross_tenant";
  }

  assert.deepEqual(second.personalizationCases[0]?.expectedPageIds, ["alex-project-atlas-launch"]);
  assert.deepEqual(second.temporalCases[0]?.window, {
    start: "2026-07-16T00:00:00.000Z",
    end: "2026-07-17T00:00:00.000Z",
  });
  assert.equal(second.abstentionCases[0]?.reason, "missing_fact");
});

test("schema tier smoke fixture preserves shared semantics while trimming the corpus", () => {
  assert.equal(SCHEMA_TIER_SMOKE_FIXTURE.clean.pages.length, 6);
  assert.equal(SCHEMA_TIER_SMOKE_FIXTURE.dirty.pages.length, 6);
  assert.equal(SCHEMA_TIER_SMOKE_FIXTURE.personalizationCases.length, 3);
  assert.equal(SCHEMA_TIER_SMOKE_FIXTURE.temporalCases.length, 1);
  assert.equal(SCHEMA_TIER_SMOKE_FIXTURE.abstentionCases.length, 1);
});
