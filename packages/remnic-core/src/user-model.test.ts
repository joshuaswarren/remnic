import test from "node:test";
import assert from "node:assert/strict";

import {
  USER_MODEL_CORE_QUESTION,
  USER_MODEL_DIMENSIONS,
  USER_CONTEXT_SCOPES,
  facetHasBoundary,
  isUserBoundaryScope,
  isUserContextScope,
  isUserModelDimension,
  normalizeUserContextScope,
  normalizeUserModelDimension,
  summarizeUserModelCoverage,
  type UserModelFacet,
} from "./user-model.js";

test("user-model contract includes the required user-aware dimensions", () => {
  assert.equal(
    USER_MODEL_CORE_QUESTION,
    "What does the agent need to understand about this user to act well right now?",
  );
  assert.deepEqual(USER_MODEL_DIMENSIONS, [
    "preferences",
    "goals",
    "projects",
    "constraints",
    "current_priorities",
    "communication_style",
    "risk_tolerance",
    "people_relationships",
    "past_decisions",
    "definitions_of_good",
    "ask_before_rules",
    "do_not_use_outside_rules",
  ]);
});

test("user context scopes include trust and boundary scopes", () => {
  assert.deepEqual(USER_CONTEXT_SCOPES, [
    "personal",
    "work",
    "client",
    "project",
    "repo",
    "tool",
    "temporary",
    "private",
    "do-not-use-outside-this-context",
  ]);
  assert.equal(isUserContextScope("repo"), true);
  assert.equal(isUserContextScope("global"), false);
});

test("dimension normalization accepts human labels and rejects unknown values", () => {
  assert.equal(isUserModelDimension("preferences"), true);
  assert.equal(normalizeUserModelDimension("Communication style"), "communication_style");
  assert.equal(normalizeUserModelDimension("Ask me before"), "ask_before_rules");
  assert.equal(normalizeUserModelDimension("people & relationships"), "people_relationships");
  assert.equal(normalizeUserModelDimension("outside the contract"), null);
  assert.equal(normalizeUserModelDimension("constructor"), null);
  assert.equal(normalizeUserModelDimension(null), null);
});

test("scope normalization accepts aliases without silently accepting invalid scopes", () => {
  assert.equal(normalizeUserContextScope("repository"), "repo");
  assert.equal(
    normalizeUserContextScope("do not use outside this context"),
    "do-not-use-outside-this-context",
  );
  assert.equal(normalizeUserContextScope("do_not_use_outside"), "do-not-use-outside-this-context");
  assert.equal(normalizeUserContextScope("global"), null);
  assert.equal(normalizeUserContextScope("constructor"), null);
  assert.equal(normalizeUserContextScope(false), null);
  assert.equal(normalizeUserContextScope("_".repeat(10_000)), null);
});

test("boundary helper identifies scopes that require stricter use decisions", () => {
  assert.equal(isUserBoundaryScope("private"), true);
  assert.equal(isUserBoundaryScope("temporary"), true);
  assert.equal(isUserBoundaryScope("work"), false);
  assert.equal(
    facetHasBoundary({
      scopes: ["work", "do-not-use-outside-this-context"],
    }),
    true,
  );
  assert.equal(facetHasBoundary({ scopes: ["work", "repo"] }), false);
});

test("core root entrypoint exports user-model guard helpers", async () => {
  const core = await import("./index.js");

  assert.equal(core.isUserModelDimension("preferences"), true);
  assert.equal(core.isUserContextScope("repo"), true);
  assert.equal(core.isUserBoundaryScope("private"), true);
});

test("coverage summary reports present and missing user-model dimensions deterministically", () => {
  const facets: UserModelFacet[] = [
    {
      dimension: "preferences",
      statement: "The user prefers terse status updates.",
      scopes: ["work"],
    },
    {
      dimension: "ask_before_rules",
      statement: "Ask before changing public APIs.",
      scopes: ["repo"],
    },
  ];

  const coverage = summarizeUserModelCoverage(facets, [
    "preferences",
    "risk_tolerance",
    "ask_before_rules",
  ]);

  assert.deepEqual(coverage.present, ["preferences", "ask_before_rules"]);
  assert.deepEqual(coverage.missing, ["risk_tolerance"]);
  assert.deepEqual(coverage.byDimension.preferences, [facets[0]]);
  assert.deepEqual(coverage.byDimension.ask_before_rules, [facets[1]]);
  assert.deepEqual(coverage.byDimension.risk_tolerance, []);
});
