import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRetrievedMemoryProvenance,
  normalizeRetrievedMemoryProvenance,
  summarizeRetrievedMemoryProvenance,
} from "./memory-provenance.js";
import type { MemoryFile, MemoryFrontmatter } from "./types.js";

const NOW = Date.parse("2026-05-01T00:00:00.000Z");

function frontmatter(
  overrides: Partial<MemoryFrontmatter> = {},
): MemoryFrontmatter {
  return {
    id: "mem-1",
    category: "preference",
    created: "2026-04-20T00:00:00.000Z",
    updated: "2026-04-21T00:00:00.000Z",
    source: "conversation",
    confidence: 0.91,
    confidenceTier: "explicit",
    tags: [],
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryFrontmatter> = {}): MemoryFile {
  return {
    path: "facts/2026-04-20/mem-1.md",
    content: "The user prefers concise status updates.",
    frontmatter: frontmatter(overrides),
  };
}

test("buildRetrievedMemoryProvenance records source, scope, confidence, and retrieval reason", () => {
  const provenance = buildRetrievedMemoryProvenance(
    memory({
      tags: ["repo", "work", "repo"],
      sourceMemoryId: "source-memory",
      sourceTurnId: "turn-7",
      derived_from: ["facts/original.md:2"],
      derived_via: "merge",
    }),
    {
      namespace: "project-alpha",
      retrievalReason: "served-by=hybrid",
      now: () => NOW,
    },
  );

  assert.equal(provenance.source, "conversation");
  assert.equal(provenance.created, "2026-04-20T00:00:00.000Z");
  assert.equal(provenance.updated, "2026-04-21T00:00:00.000Z");
  assert.equal(provenance.namespace, "project-alpha");
  assert.equal(provenance.scope, "namespace:project-alpha");
  assert.deepEqual(provenance.userContextScopes, ["repo", "work"]);
  assert.equal(provenance.retrievalReason, "served-by=hybrid");
  assert.equal(provenance.confidence, 0.91);
  assert.equal(provenance.stale, false);
  assert.equal(provenance.corrected, false);
  assert.equal(provenance.safeToUse, true);
  assert.equal(provenance.safety, "safe");
  assert.deepEqual(provenance.safetyReasons, []);
  assert.equal(provenance.sourceMemoryId, "source-memory");
  assert.equal(provenance.sourceTurnId, "turn-7");
  assert.deepEqual(provenance.derivedFrom, ["facts/original.md:2"]);
  assert.equal(provenance.derivedVia, "merge");
});

test("buildRetrievedMemoryProvenance marks stale and superseded memories as requiring review", () => {
  const provenance = buildRetrievedMemoryProvenance(
    memory({
      status: "superseded",
      lifecycleState: "stale",
      supersededBy: "newer-memory",
      invalid_at: "2026-04-30T00:00:00.000Z",
    }),
    { now: () => NOW },
  );

  assert.equal(provenance.stale, true);
  assert.equal(provenance.corrected, true);
  assert.equal(provenance.correctionState, "superseded");
  assert.equal(provenance.safeToUse, false);
  assert.equal(provenance.safety, "requires-review");
  assert.ok(provenance.safetyReasons.includes("status=superseded"));
  assert.ok(provenance.safetyReasons.includes("stale=true"));
});

test("buildRetrievedMemoryProvenance blocks forgotten and quarantined memories", () => {
  const forgotten = buildRetrievedMemoryProvenance(
    memory({
      status: "forgotten",
      forgottenAt: "2026-04-25T00:00:00.000Z",
      forgottenReason: "user asked to remove it",
    }),
    { now: () => NOW },
  );
  assert.equal(forgotten.safety, "blocked");
  assert.equal(forgotten.safeToUse, false);
  assert.equal(forgotten.correctionState, "forgotten");
  assert.equal(forgotten.forgottenReason, "user asked to remove it");

  const quarantined = buildRetrievedMemoryProvenance(
    memory({ status: "quarantined" }),
    { now: () => NOW },
  );
  assert.equal(quarantined.safety, "blocked");
  assert.ok(quarantined.safetyReasons.includes("status=quarantined"));
});

test("buildRetrievedMemoryProvenance enforces boundary scopes against current context", () => {
  const blocked = buildRetrievedMemoryProvenance(
    memory({ tags: ["repo", "do not use outside this context"] }),
    {
      currentContextScopes: ["repo"],
      now: () => NOW,
    },
  );

  assert.equal(blocked.safety, "blocked");
  assert.equal(blocked.safeToUse, false);
  assert.ok(
    blocked.safetyReasons.includes(
      "boundary-blocked=do-not-use-outside-this-context",
    ),
  );

  const inScope = buildRetrievedMemoryProvenance(
    memory({ tags: ["repo", "do not use outside this context"] }),
    {
      currentContextScopes: ["do-not-use-outside-this-context"],
      now: () => NOW,
    },
  );
  assert.equal(inScope.safety, "safe");
  assert.deepEqual(inScope.safetyReasons, []);
});

test("normalizeRetrievedMemoryProvenance clamps and drops malformed fields", () => {
  const normalized = normalizeRetrievedMemoryProvenance({
    source: " import ",
    scope: "",
    userContextScopes: ["repository", "constructor", "private"],
    retrievalReason: "",
    confidence: 2,
    stale: true,
    corrected: false,
    correctionState: "disputed",
    safety: "bogus",
    safeToUse: false,
    safetyReasons: [" stale=true ", "", 7],
    status: "bogus",
    lifecycleState: "archived",
    verificationState: "disputed",
    policyClass: "protected",
    derivedFrom: ["a:1", "", "a:1"],
    derivedVia: "pattern-reinforcement",
  });

  assert.ok(normalized);
  assert.equal(normalized.source, "import");
  assert.equal(normalized.scope, "unknown");
  assert.deepEqual(normalized.userContextScopes, ["repo", "private"]);
  assert.equal(normalized.retrievalReason, "retrieved");
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.corrected, true);
  assert.equal(normalized.correctionState, "disputed");
  assert.equal(normalized.safeToUse, false);
  assert.equal(normalized.safety, "requires-review");
  assert.deepEqual(normalized.safetyReasons, ["stale=true"]);
  assert.equal(normalized.status, undefined);
  assert.equal(normalized.lifecycleState, "archived");
  assert.equal(normalized.verificationState, "disputed");
  assert.equal(normalized.policyClass, "protected");
  assert.deepEqual(normalized.derivedFrom, ["a:1"]);
  assert.equal(normalized.derivedVia, "pattern-reinforcement");
});

test("summarizeRetrievedMemoryProvenance produces stable compact text", () => {
  const provenance = buildRetrievedMemoryProvenance(
    memory({ tags: ["work"] }),
    {
      namespace: "default",
      retrievalReason: "served-by=recent-scan",
      now: () => NOW,
    },
  );

  assert.equal(
    summarizeRetrievedMemoryProvenance(provenance),
    "source=conversation created=2026-04-20T00:00:00.000Z scope=namespace:default confidence=0.91 stale=false corrected=false safe=true",
  );
});
