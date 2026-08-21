/**
 * Regression tests for the skill-bundle projection contract (issue #2369).
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { MemoryFile, MemoryStatus } from "../types.js";
import { buildProcedurePersistBody, parseProcedureStepsFromBody } from "./procedure-types.js";
import {
  parseSkillBundle,
  parseSkillProjectionConfig,
  projectProceduresToSkills,
  renderSkillBundle,
  sanitizeSkillSlug,
} from "./skill-projection.js";

const STEPS = [
  { order: 1, intent: "Read the failing test output." },
  { order: 2, intent: "Fix the smallest cause.", expectedOutcome: "The suite passes." },
];

function makeProcedure(options: {
  id: string;
  title: string;
  status?: MemoryStatus;
  updated?: string;
  category?: string;
}): MemoryFile {
  return {
    path: `procedures/2026-08-18/${options.id}.md`,
    content: buildProcedurePersistBody(options.title, STEPS),
    frontmatter: {
      id: options.id,
      category: (options.category ?? "procedure") as MemoryFile["frontmatter"]["category"],
      created: "2026-08-18T00:00:00.000Z",
      updated: options.updated ?? "2026-08-18T00:00:00.000Z",
      source: "procedure-miner",
      confidence: 0.8,
      confidenceTier: "explicit",
      tags: [],
      ...(options.status ? { status: options.status } : {}),
    } as MemoryFile["frontmatter"],
  };
}

test("the stored machine attributes footer never reaches the skill body", () => {
  const memory = makeProcedure({ id: "procedure-1", title: "Fix a failing test" });
  memory.content = `${memory.content}\n[Attributes: procedure_cluster: abc; trajectory_count: 4]`;
  const bundles = projectProceduresToSkills([memory]);
  assert.equal(bundles.length, 1);
  assert.ok(!bundles[0].body.includes("[Attributes:"));
  assert.equal(bundles[0].body.trimEnd().endsWith("The suite passes."), true);
  assert.equal(parseProcedureStepsFromBody(bundles[0].body)?.length, 2);
  assert.equal(parseProcedureStepsFromBody(bundles[0].body)?.[1].intent, "Fix the smallest cause.");
});

test("projects active procedures and round-trips the steps through parseProcedureStepsFromBody", () => {
  const bundles = projectProceduresToSkills([
    makeProcedure({ id: "procedure-1", title: "Fix a failing test" }),
  ]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].slug, "fix-a-failing-test");
  assert.equal(bundles[0].frontmatter.name, "fix-a-failing-test");
  assert.equal(bundles[0].frontmatter.description, "Fix a failing test");
  assert.equal(bundles[0].provenance.memoryId, "procedure-1");

  const rendered = renderSkillBundle(bundles[0]);
  const parsed = parseSkillBundle(rendered, bundles[0].slug);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.steps?.map((s) => ({ order: s.order, intent: s.intent })),
    parseProcedureStepsFromBody(bundles[0].body)?.map((s) => ({ order: s.order, intent: s.intent })),
  );
  assert.equal(parsed.steps?.length, 2);
  assert.equal(parsed.steps?.[1].expectedOutcome, "The suite passes.");
  assert.equal(parsed.provenance.memoryId, "procedure-1");
});

test("never projects a non-active status (every status enumerated)", () => {
  const statuses: MemoryStatus[] = [
    "pending_review",
    "rejected",
    "quarantined",
    "superseded",
    "archived",
    "forgotten",
  ];
  for (const status of statuses) {
    const bundles = projectProceduresToSkills([
      makeProcedure({ id: `procedure-${status}`, title: `Do ${status} work`, status }),
    ]);
    assert.deepEqual(bundles, [], `${status} must not project`);
  }
  // Sanity: the same memory projects once its status is active.
  assert.equal(
    projectProceduresToSkills([makeProcedure({ id: "procedure-ok", title: "Do active work", status: "active" })])
      .length,
    1,
  );
});

test("non-procedure categories are excluded", () => {
  const bundles = projectProceduresToSkills([
    makeProcedure({ id: "fact-1", title: "Not a procedure", category: "fact" }),
  ]);
  assert.deepEqual(bundles, []);
});

test("duplicate titles yield distinct stable slugs", () => {
  const memories = [
    makeProcedure({ id: "procedure-a", title: "Deploy the service", updated: "2026-08-18T03:00:00.000Z" }),
    makeProcedure({ id: "procedure-b", title: "Deploy the service!", updated: "2026-08-18T02:00:00.000Z" }),
    makeProcedure({ id: "procedure-c", title: "Deploy the service?", updated: "2026-08-18T01:00:00.000Z" }),
  ];
  const first = projectProceduresToSkills(memories).map((b) => b.slug);
  assert.deepEqual(first, ["deploy-the-service", "deploy-the-service-2", "deploy-the-service-3"]);
  // Stable across runs, and stable when the input order changes (sort is total).
  assert.deepEqual(projectProceduresToSkills([...memories].reverse()).map((b) => b.slug), first);
});

test("ties on updated fall back to id order, so ordering is deterministic", () => {
  const memories = [
    makeProcedure({ id: "procedure-z", title: "Zed task", updated: "2026-08-18T00:00:00.000Z" }),
    makeProcedure({ id: "procedure-a", title: "Alpha task", updated: "2026-08-18T00:00:00.000Z" }),
  ];
  assert.deepEqual(projectProceduresToSkills(memories).map((b) => b.slug), ["alpha-task", "zed-task"]);
  assert.deepEqual(projectProceduresToSkills([...memories].reverse()).map((b) => b.slug), [
    "alpha-task",
    "zed-task",
  ]);
});

test("reserved slugs are prefixed rather than shadowed", () => {
  const bundles = projectProceduresToSkills(
    [makeProcedure({ id: "procedure-1", title: "remnic memory workflow" })],
    { reservedSlugs: ["remnic-memory-workflow"] },
  );
  assert.equal(bundles[0].slug, "user-remnic-memory-workflow");
});

test("maxSkills caps the projection and 0 disables it", () => {
  const memories = [
    makeProcedure({ id: "procedure-a", title: "Task A", updated: "2026-08-18T03:00:00.000Z" }),
    makeProcedure({ id: "procedure-b", title: "Task B", updated: "2026-08-18T02:00:00.000Z" }),
  ];
  assert.equal(projectProceduresToSkills(memories, { maxSkills: 1 }).length, 1);
  // Newest first.
  assert.equal(projectProceduresToSkills(memories, { maxSkills: 1 })[0].slug, "task-a");
  assert.deepEqual(projectProceduresToSkills(memories, { maxSkills: 0 }), []);
});

test("rendered frontmatter survives titles containing YAML metacharacters", () => {
  const bundles = projectProceduresToSkills([
    makeProcedure({ id: "procedure-1", title: "When you work on goals like: ship #2369" }),
  ]);
  const parsed = parseSkillBundle(renderSkillBundle(bundles[0]), bundles[0].slug);
  assert.equal(parsed?.description, "When you work on goals like: ship #2369");
  assert.equal(bundles[0].slug, "when-you-work-on-goals-like-ship-2369");
});

test("parseSkillBundle tolerates a step-less body and a missing frontmatter block", () => {
  const parsed = parseSkillBundle("Just prose, no steps.\n", "prose");
  assert.equal(parsed?.steps, null);
  assert.equal(parsed?.body, "Just prose, no steps.");
  assert.equal(parsed?.provenance.memoryId, undefined);
  assert.equal(parseSkillBundle("---\nname: empty\n---\n\n", "empty"), null);
});

test("parseSkillBundle ignores nested frontmatter sequences", () => {
  const text = [
    "---",
    "name: deploy",
    "description: Deploy the thing",
    "allowed-tools:",
    "  - remnic_recall",
    "---",
    "",
    "Deploy the thing",
    "",
    "## Step 1",
    "",
    "Push the button.",
    "",
  ].join("\n");
  const parsed = parseSkillBundle(text, "deploy");
  assert.equal(parsed?.description, "Deploy the thing");
  assert.equal(parsed?.steps?.length, 1);
  assert.equal(parsed?.steps?.[0].intent, "Push the button.");
});

test("sanitizeSkillSlug produces valid slugs for hostile titles", () => {
  assert.equal(sanitizeSkillSlug("  ///  "), "procedure");
  assert.equal(sanitizeSkillSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeSkillSlug("Ünïcodé Title"), "n-cod-title");
  assert.equal(sanitizeSkillSlug("A".repeat(120)).length, 64);
});

test("parseSkillProjectionConfig defaults off, coerces strings, and rejects garbage", () => {
  assert.deepEqual(parseSkillProjectionConfig(undefined), { enabled: false, maxSkills: 20 });
  assert.deepEqual(parseSkillProjectionConfig({ enabled: "true", maxSkills: "5" }), {
    enabled: true,
    maxSkills: 5,
  });
  // String "false"/"0" must read as falsy / as the documented disable value.
  assert.deepEqual(parseSkillProjectionConfig({ enabled: "false", maxSkills: "0" }), {
    enabled: false,
    maxSkills: 0,
  });
  assert.throws(() => parseSkillProjectionConfig({ enabled: "maybe" }), /skillProjection\.enabled/);
  assert.throws(() => parseSkillProjectionConfig({ maxSkills: 2.5 }), /integer/);
  assert.throws(() => parseSkillProjectionConfig({ maxSkills: -1 }), /between 0/);
  assert.throws(() => parseSkillProjectionConfig([]), /must be an object/);
});
