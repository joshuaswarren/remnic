import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessIdentityContinuitySurface,
  type AccessIdentityContinuitySurfaceDeps,
} from "./access-identity-continuity-surface.js";
import { EngramAccessInputError } from "./access-service.js";
import { parseConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import type { StorageManager } from "./storage.js";

interface HarnessOptions {
  readonly config?: Record<string, unknown>;
  readonly identityAnchor?: string | null;
  readonly identityReflections?: string | null;
  readonly closeIncidentFound?: boolean;
  readonly reviewLoopFound?: boolean;
}

interface HarnessCalls {
  readonly audit: Array<{ period: "weekly" | "monthly"; key?: string }>;
  readonly storageNamespaces: string[];
  readonly readableNamespaces: Array<{ namespace?: string; principal?: string }>;
  readonly writableNamespaces: Array<{ namespace?: string; sessionKey?: string; principal?: string }>;
  readonly incidentAppends: Array<{
    symptom: string;
    triggerWindow?: string;
    suspectedCause?: string;
  }>;
  readonly incidentCloses: Array<{
    id: string;
    patch: { fixApplied: string; verificationResult: string; preventiveRule?: string };
  }>;
  readonly incidentReads: Array<{ limit: number; state: "open" | "closed" | "all" }>;
  readonly loopUpserts: Array<Record<string, unknown>>;
  readonly loopReviews: Array<{ id: string; patch: Record<string, unknown> }>;
  readonly anchorWrites: string[];
}

function createHarness(options: HarnessOptions = {}): {
  surface: AccessIdentityContinuitySurface;
  calls: HarnessCalls;
} {
  const calls: HarnessCalls = {
    audit: [],
    storageNamespaces: [],
    readableNamespaces: [],
    writableNamespaces: [],
    incidentAppends: [],
    incidentCloses: [],
    incidentReads: [],
    loopUpserts: [],
    loopReviews: [],
    anchorWrites: [],
  };

  const storageFixture = {
    async appendContinuityIncident(input: HarnessCalls["incidentAppends"][number]) {
      calls.incidentAppends.push(input);
      return { id: "incident-1", state: "open", ...input };
    },
    async closeContinuityIncident(id: string, patch: HarnessCalls["incidentCloses"][number]["patch"]) {
      calls.incidentCloses.push({ id, patch });
      return options.closeIncidentFound === false ? null : { id, state: "closed", ...patch };
    },
    async readContinuityIncidents(limit: number, state: "open" | "closed" | "all") {
      calls.incidentReads.push({ limit, state });
      return [{ id: "incident-1", state }];
    },
    async upsertIdentityImprovementLoop(input: Record<string, unknown>) {
      calls.loopUpserts.push(input);
      return input;
    },
    async reviewIdentityImprovementLoop(id: string, patch: Record<string, unknown>) {
      calls.loopReviews.push({ id, patch });
      return options.reviewLoopFound === false ? null : { id, ...patch };
    },
    async readIdentityAnchor() {
      return options.identityAnchor ?? null;
    },
    async writeIdentityAnchor(content: string) {
      calls.anchorWrites.push(content);
    },
    async readIdentityReflections() {
      return options.identityReflections ?? null;
    },
  };
  // The surface deliberately consumes only this storage subset; the cast keeps
  // the fixture honest at each method while avoiding a full filesystem store.
  const storage = storageFixture as unknown as StorageManager;

  const config = parseConfig({
    memoryDir: "/tmp/remnic-access-identity-test",
    identityContinuityEnabled: true,
    continuityIncidentLoggingEnabled: true,
    continuityAuditEnabled: true,
    compoundingEnabled: true,
    ...options.config,
  });
  const orchestratorFixture = {
    config,
    compounding: {
      async synthesizeContinuityAudit(input: { period: "weekly" | "monthly"; key?: string }) {
        calls.audit.push(input);
        return {
          period: input.period,
          key: input.key ?? "2026-W28",
          reportPath: "/tmp/continuity-audit.md",
        };
      },
    },
    async getStorage(namespace: string) {
      calls.storageNamespaces.push(namespace);
      return storage;
    },
  };
  // Access surfaces accept the live orchestrator; this named fixture supplies
  // the exact members this surface owns and no unrelated runtime machinery.
  const orchestrator = orchestratorFixture as unknown as Orchestrator;

  const deps: AccessIdentityContinuitySurfaceDeps = {
    orchestrator,
    resolveReadableNamespace(namespace, principal) {
      calls.readableNamespaces.push({ namespace, principal });
      return "readable-ns";
    },
    writableNamespaceFor(namespace, sessionKey, principal) {
      calls.writableNamespaces.push({ namespace, sessionKey, principal });
      return "writable-ns";
    },
  };

  return { surface: new AccessIdentityContinuitySurface(deps), calls };
}

test("continuity capability gates stop before storage or compounding work", async () => {
  const { surface, calls } = createHarness({
    config: { identityContinuityEnabled: false },
  });

  assert.deepEqual(await surface.continuityAuditGenerate({}), {
    enabled: false,
    reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`.",
  });
  assert.deepEqual(await surface.continuityIncidentOpen({ symptom: "lost context" }), {
    enabled: false,
    reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`.",
  });
  assert.deepEqual(calls.audit, []);
  assert.deepEqual(calls.storageNamespaces, []);
});

test("continuity audits normalize inputs and forward to compounding", async () => {
  const { surface, calls } = createHarness();

  assert.deepEqual(await surface.continuityAuditGenerate({ period: "monthly", key: " 2026-07 " }), {
    enabled: true,
    period: "monthly",
    key: "2026-07",
    reportPath: "/tmp/continuity-audit.md",
  });
  assert.deepEqual(calls.audit, [{ period: "monthly", key: "2026-07" }]);
});

test("incident writes validate required fields and use writable namespace routing", async () => {
  const { surface, calls } = createHarness();

  await assert.rejects(
    surface.continuityIncidentOpen({ symptom: "   " }),
    (error: unknown) => error instanceof EngramAccessInputError && error.message === "symptom is required"
  );
  assert.deepEqual(
    await surface.continuityIncidentOpen({
      symptom: " lost context ",
      namespace: "requested",
      principal: "agent-a",
      triggerWindow: " last hour ",
      suspectedCause: " cache reset ",
    }),
    {
      created: true,
      incident: {
        id: "incident-1",
        state: "open",
        symptom: "lost context",
        triggerWindow: "last hour",
        suspectedCause: "cache reset",
      },
    }
  );
  assert.deepEqual(calls.writableNamespaces, [{ namespace: "requested", sessionKey: undefined, principal: "agent-a" }]);
  assert.deepEqual(calls.storageNamespaces, ["writable-ns"]);
  assert.deepEqual(calls.incidentAppends, [
    {
      symptom: "lost context",
      triggerWindow: "last hour",
      suspectedCause: "cache reset",
    },
  ]);
});

test("incident reads clamp limits and use readable namespace routing", async () => {
  const { surface, calls } = createHarness();

  assert.deepEqual(
    await surface.continuityIncidentList({
      state: "all",
      limit: 500,
      namespace: "requested",
      principal: "agent-a",
    }),
    {
      state: "all",
      incidents: [{ id: "incident-1", state: "all" }],
      count: 1,
    }
  );
  assert.deepEqual(calls.readableNamespaces, [{ namespace: "requested", principal: "agent-a" }]);
  assert.deepEqual(calls.storageNamespaces, ["readable-ns"]);
  assert.deepEqual(calls.incidentReads, [{ limit: 200, state: "all" }]);
});

test("incident close and continuity-loop operations preserve validation and forwarding", async () => {
  const { surface, calls } = createHarness();

  await assert.rejects(
    surface.continuityIncidentClose({ id: "", fixApplied: "fixed", verificationResult: "green" }),
    (error: unknown) => error instanceof EngramAccessInputError && error.message === "id is required"
  );
  assert.deepEqual(
    await surface.continuityIncidentClose({
      id: " incident-1 ",
      fixApplied: " restored state ",
      verificationResult: " replay passed ",
      preventiveRule: " flush first ",
    }),
    {
      closed: true,
      incident: {
        id: "incident-1",
        state: "closed",
        fixApplied: "restored state",
        verificationResult: "replay passed",
        preventiveRule: "flush first",
      },
    }
  );
  assert.deepEqual(
    await surface.continuityLoopAddOrUpdate({
      id: " loop-1 ",
      cadence: "weekly",
      purpose: " verify continuity ",
      status: "active",
      killCondition: " stable for a month ",
      notes: " watch restarts ",
    }),
    {
      saved: true,
      loop: {
        id: "loop-1",
        cadence: "weekly",
        purpose: "verify continuity",
        status: "active",
        killCondition: "stable for a month",
        lastReviewed: undefined,
        notes: "watch restarts",
      },
    }
  );
  assert.deepEqual(
    await surface.continuityLoopReview({
      id: " loop-1 ",
      status: "paused",
      reviewedAt: " 2026-07-10T00:00:00Z ",
    }),
    {
      reviewed: true,
      loop: {
        id: "loop-1",
        status: "paused",
        notes: undefined,
        reviewedAt: "2026-07-10T00:00:00Z",
      },
    }
  );
  assert.equal(calls.incidentCloses.length, 1);
  assert.equal(calls.loopUpserts.length, 1);
  assert.equal(calls.loopReviews.length, 1);
});

test("identity anchor updates merge conservatively without dropping custom sections", async () => {
  const existingAnchor = [
    "# Identity Continuity Anchor",
    "",
    "## Identity Traits",
    "",
    "- Careful",
    "",
    "## Communication Preferences",
    "",
    "- Brief",
    "",
    "## Custom Notes",
    "",
    "Keep me",
    "",
  ].join("\n");
  const { surface, calls } = createHarness({ identityAnchor: existingAnchor });
  const expectedAnchor = [
    "# Identity Continuity Anchor",
    "",
    "## Identity Traits",
    "",
    "- Careful",
    "",
    "## Communication Preferences",
    "",
    "- Brief",
    "- Direct",
    "",
    "## Operating Principles",
    "",
    "- Verify",
    "",
    "## Continuity Notes",
    "",
    "## Custom Notes",
    "",
    "Keep me",
    "",
  ].join("\n");

  assert.deepEqual(
    await surface.identityAnchorUpdate({
      identityTraits: "- Careful",
      communicationPreferences: "- Brief\n- Direct",
      operatingPrinciples: "- Verify",
    }),
    {
      updated: true,
      sections: ["Identity Traits", "Communication Preferences", "Operating Principles"],
      anchor: expectedAnchor,
    }
  );
  assert.deepEqual(calls.anchorWrites, [expectedAnchor]);
});

test("identity reads use readable routing and preserve not-found results", async () => {
  const foundHarness = createHarness({
    identityAnchor: "# Identity Continuity Anchor\n",
    identityReflections: "# Identity Reflections\n",
  });

  assert.deepEqual(await foundHarness.surface.identityAnchorGet({ namespace: "requested" }), {
    found: true,
    anchor: "# Identity Continuity Anchor\n",
  });
  assert.deepEqual(await foundHarness.surface.memoryIdentity({ namespace: "requested" }), {
    found: true,
    identity: "# Identity Reflections\n",
  });
  assert.deepEqual(foundHarness.calls.storageNamespaces, ["readable-ns", "readable-ns"]);

  const missingHarness = createHarness();
  assert.deepEqual(await missingHarness.surface.identityAnchorGet({}), {
    found: false,
    message: "No identity anchor found yet. Use identity_anchor_update to create one.",
  });
  assert.deepEqual(await missingHarness.surface.memoryIdentity({}), {
    found: false,
    message: "No identity reflections found.",
  });
});
