/**
 * #1505 thread 2f7: the `disclosure: "raw"` excerpt path MUST pass through the
 * SAME read-authorization gate as normal recall + `lcmSearch` + the in-prompt
 * LCM sections — NOT `snapshot.namespace` (the effective WRITE/overlay
 * namespace).
 *
 * The defect class: a project-scoped session whose principal can WRITE but not
 * READ its self base (or whose `defaultRecallNamespaces` omits `self`) archives
 * LCM rows under the `<principal>-project-*` overlay key (the write key). When
 * `recall({ disclosure: "raw" })` derived the raw-excerpt LCM `session_id` from
 * `snapshot.namespace`, it prefixed the lookup with that overlay namespace and
 * surfaced `<principal>-project-*` transcript rows that normal recall and
 * `lcmSearch` intentionally EXCLUDE for that reader — a cross-tenant read leak.
 *
 * After the fix the raw-excerpt lookup routes through
 * `resolveRawExcerptReadNamespace` → `resolveLcmReadNamespace(..., "read")`,
 * which honours the overlay only when the principal SELF base is in the readable
 * recall set. When it is not, the lookup falls back to the default store (raw
 * sessionKey) exactly like normal recall + `lcmSearch`.
 *
 * These tests exercise the private `executeRecall` directly (the budget /
 * idempotency wrapper is orthogonal to the namespace gate) and assert the
 * `session_id` that reaches the LCM engine's `searchContextFull`.
 *
 * All fixtures are synthetic — no real user data.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { CrossNamespaceBudget } from "./cross-namespace-budget.js";
import { Orchestrator } from "./orchestrator.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import {
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import type { StorageManager } from "./storage.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface RawExcerptProbe {
  service: EngramAccessService;
  /** session_id values that reached the LCM engine's `searchContextFull`. */
  searchSessionIds: Array<string | undefined>;
  contexts: Map<string, CodingContext>;
}

/**
 * Build a service whose orchestrator stub:
 *  - delegates principal / overlay resolution to the REAL Orchestrator
 *    prototype so the read gate is exercised exactly as production does it,
 *  - records the `session_id` the raw-excerpt LCM lookup prefixes,
 *  - returns a fixed `lastRecall` snapshot whose `namespace` is the WRITE/overlay
 *    namespace (simulating what `observe` wrote), with NO result paths so the
 *    test isolates the raw-excerpt session_id.
 */
function makeRawExcerptProbe(options: {
  config: Partial<PluginConfig>;
  snapshotNamespace: string;
  sessionContext?: CodingContext;
  sessionKey: string;
}): RawExcerptProbe {
  const searchSessionIds: Array<string | undefined> = [];
  const contexts = new Map<string, CodingContext>();
  if (options.sessionContext) {
    contexts.set(options.sessionKey, options.sessionContext);
  }

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-raw-excerpt-read-gate",
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    ...options.config,
  } as unknown as PluginConfig;

  const snapshot: LastRecallSnapshot = {
    sessionKey: options.sessionKey,
    recordedAt: new Date().toISOString(),
    queryHash: "hash",
    queryLen: 5,
    memoryIds: [],
    namespace: options.snapshotNamespace,
    recallNamespaces: [options.snapshotNamespace],
    includedMemories: [],
  };

  const storage = {
    dir: "/synthetic/remnic-raw-excerpt-read-gate/store",
    async readMemoryByPath() {
      return null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  const service = Object.create(
    EngramAccessService.prototype,
  ) as EngramAccessService;

  const orch = {
    config,
    getCodingContextForSession: (sk: string | undefined) =>
      (sk ? contexts.get(sk) : null) ?? null,
    setCodingContextForSession: (sk: string, ctx: CodingContext | null) => {
      if (ctx === null) contexts.delete(sk);
      else contexts.set(sk, ctx);
    },
    applyCodingNamespaceOverlay: (sk: string | undefined, base: string) =>
      Orchestrator.prototype.applyCodingNamespaceOverlay.call(orch, sk, base),
    resolvePrincipal: (sk?: string) =>
      Orchestrator.prototype.resolvePrincipal.call(orch, sk),
    resolveSelfNamespace: (sk?: string) =>
      Orchestrator.prototype.resolveSelfNamespace.call(orch, sk),
    async getStorage() {
      return storage;
    },
    lastRecall: new Map<string, LastRecallSnapshot>([
      [options.sessionKey, snapshot],
    ]),
    async recall() {
      return "";
    },
    lcmEngine: {
      enabled: true,
      searchContextFull: async (
        _query: string,
        _limit: number,
        sessionId?: string,
      ) => {
        searchSessionIds.push(sessionId);
        return [];
      },
    },
  } as unknown as Orchestrator;

  (service as unknown as { orchestrator: Orchestrator }).orchestrator = orch;

  // `executeRecall` consults the cross-namespace budget; `Object.create` skips
  // the constructor that builds the real limiter, so install one. Budget is
  // disabled in config, so it never denies — orthogonal to the namespace gate.
  (service as unknown as { budget: CrossNamespaceBudget }).budget =
    new CrossNamespaceBudget({
      enabled: false,
      windowMs: 60_000,
      softLimit: 10,
      hardLimit: 30,
    });

  return { service, searchSessionIds, contexts };
}

type ExecuteRecallInternals = {
  executeRecall: (request: unknown) => Promise<unknown>;
};

type RawExcerptInternals = {
  fetchRawExcerpts: (
    disclosure: "raw",
    context: { query: string; sessionKey: string; lcmSessionIds: string[] },
  ) => Promise<Array<{ turnIndex: number; role: string; content: string; sessionId: string }> | null>;
};

const SESSION_KEY = "pi-geek:abc123";
const PROJECT_TAG = "Acme/Webshop";

function overlayNamespace(): string {
  return combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId(PROJECT_TAG)),
  );
}

function sessionContext(): CodingContext {
  return {
    projectId: projectTagProjectId(PROJECT_TAG),
    branch: null,
    rootPath: projectTagProjectId(PROJECT_TAG),
    defaultBranch: null,
  };
}

test("#1505 thread 2f7: WRITE-only / self-unreadable principal ⇒ raw excerpts fall back to the default store (no overlay prefix)", async () => {
  // Self namespace EXISTS and is WRITABLE by pi-geek, but NOT readable by it
  // (only `other` may read). An unqualified project-scoped observe archived LCM
  // under the `<pi-geek>-project-*` overlay key. The read gate
  // (`recallNamespacesForPrincipal`) excludes that overlay for pi-geek, so raw
  // disclosure MUST fall back to the default store — the raw sessionKey — never
  // the overlay key.
  const probe = makeRawExcerptProbe({
    config: {
      namespacePolicies: [
        { name: "pi-geek", readPrincipals: ["other"], writePrincipals: ["pi-geek"] },
      ],
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    },
    snapshotNamespace: overlayNamespace(),
    sessionContext: sessionContext(),
    sessionKey: SESSION_KEY,
  });

  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    authenticatedPrincipal: "pi-geek",
    disclosure: "raw",
  });

  assert.equal(probe.searchSessionIds.length, 1, "raw excerpt lookup must run once");
  // FAIL-BEFORE: previously prefixed with `snapshot.namespace` (the overlay),
  // i.e. `${overlayNamespace()}:${SESSION_KEY}`. PASS-AFTER: gated read namespace
  // collapses to the default store ⇒ the raw sessionKey.
  assert.equal(
    probe.searchSessionIds[0],
    SESSION_KEY,
    "raw excerpts must NOT prefix with the unreadable overlay namespace",
  );
});

test("#1505 thread 2f7: defaultRecallNamespaces omits 'self' ⇒ raw excerpts fall back to the default store", async () => {
  // pi-geek may both read AND write its self base, but the operator's
  // `defaultRecallNamespaces` omits `self`, so normal recall + lcmSearch never
  // surface overlay rows for this reader. Raw disclosure must match.
  const probe = makeRawExcerptProbe({
    config: {
      defaultRecallNamespaces: ["shared"],
      namespacePolicies: [
        { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      ],
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    },
    snapshotNamespace: overlayNamespace(),
    sessionContext: sessionContext(),
    sessionKey: SESSION_KEY,
  });

  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    authenticatedPrincipal: "pi-geek",
    disclosure: "raw",
  });

  assert.equal(probe.searchSessionIds.length, 1);
  assert.equal(
    probe.searchSessionIds[0],
    SESSION_KEY,
    "self-omitted recall set ⇒ raw excerpts fall back to the default store",
  );
});

test("#1505 thread 2f7 (positive): overlay IS readable ⇒ raw disclosure includes the overlay rows", async () => {
  // pi-geek may read its self base AND `defaultRecallNamespaces` includes
  // `self`, so the overlay is in the readable recall set. Raw disclosure MUST
  // continue to prefix with the overlay key so the session finds its own
  // project-scoped transcript rows (no regression for the normal case).
  const probe = makeRawExcerptProbe({
    config: {
      defaultRecallNamespaces: ["self", "shared"],
      namespacePolicies: [
        { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      ],
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    },
    snapshotNamespace: overlayNamespace(),
    sessionContext: sessionContext(),
    sessionKey: SESSION_KEY,
  });

  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    authenticatedPrincipal: "pi-geek",
    disclosure: "raw",
  });

  assert.equal(probe.searchSessionIds.length, 1);
  assert.equal(
    probe.searchSessionIds[0],
    lcmSessionKeyForNamespace(overlayNamespace(), SESSION_KEY, "default"),
    "readable overlay ⇒ raw disclosure keeps the overlay prefix",
  );
});

test("#1505 thread NBHWz (codex P2): restrictive `default` READ policy + readable self ⇒ raw excerpts read the self/recall-authorized namespace (no `not readable: default` throw)", async () => {
  // The root defect: the raw-excerpt path PRE-authorized
  // `undefined ⇒ config.defaultNamespace` via `resolveReadableNamespace` BEFORE
  // computing the LCM excerpt key. Under a deployment whose `default` namespace
  // has a RESTRICTIVE read policy (pi-geek may NOT read `default`) but where
  // pi-geek's self namespace IS readable, normal recall still succeeds via
  // `recallNamespacesForPrincipal`, yet `disclosure: "raw"` threw `namespace is
  // not readable: default` before serialization.
  //
  // FAIL-BEFORE: `executeRecall({ disclosure: "raw" })` throws `namespace is not
  // readable: default`. PASS-AFTER: the fallback comes from the already
  // read-authorized recall namespace set, so the raw lookup runs and prefixes
  // its LCM session_id with the readable self namespace (no pre-auth of default).
  const probe = makeRawExcerptProbe({
    config: {
      // RESTRICTIVE default: pi-geek may NOT read `default`.
      namespacePolicies: [
        { name: "default", readPrincipals: [], writePrincipals: [] },
        { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      ],
      // self IS in the recall set and IS readable, so the overlay resolves and
      // the read gate keeps it (no pre-auth of the denied default).
      defaultRecallNamespaces: ["self", "shared"],
      codingMode: { projectScope: true, branchScope: false, globalFallback: true },
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    },
    // snapshot.namespace records the overlay (the write target observe used);
    // the read gate independently derives the readable overlay.
    snapshotNamespace: overlayNamespace(),
    sessionContext: sessionContext(),
    sessionKey: SESSION_KEY,
  });

  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    authenticatedPrincipal: "pi-geek",
    disclosure: "raw",
  });

  assert.ok(
    probe.searchSessionIds.length >= 1,
    "raw excerpt lookup must run (NOT throw `not readable: default`)",
  );
  // The readable self overlay is honoured ⇒ the PRIMARY LCM session_id is
  // prefixed with it, matching what normal recall + `lcmSearch` search for this
  // principal. The premature `default` read-auth (which would have thrown) is
  // gone. (The fallback-unification may append project/root read-fallback keys
  // after the primary; the primary overlay key is what matters here.)
  assert.equal(
    probe.searchSessionIds[0],
    lcmSessionKeyForNamespace(overlayNamespace(), SESSION_KEY, "default"),
    "raw excerpts must read the recall-authorized self overlay, not pre-authorize the denied default",
  );
  // No queried key may be the bare default-store key (the unprefixed raw
  // sessionKey) — that would mean the read gate fell back to the DENIED default
  // store. Every searched key must be namespace-prefixed with an AUTHORIZED
  // namespace the principal may read (the `pi-geek` self base or its
  // `pi-geek-project-*` overlay), matching what normal recall + `lcmSearch`
  // search.
  // #1495 P1: the namespaced key is sentinel-framed (`\x1f<ns>\x1f<sessionKey>`),
  // so parse the namespace out of the frame and assert it is an authorized
  // pi-geek namespace (the self base or its `pi-geek-project-*` overlay).
  const SENTINEL = "\u001f";
  for (const id of probe.searchSessionIds) {
    assert.notEqual(
      id,
      SESSION_KEY,
      "raw-excerpt LCM keys must NOT fall back to the bare default store (the denied default)",
    );
    assert.ok(
      typeof id === "string" && id.startsWith(SENTINEL),
      `every raw-excerpt LCM key must be the sentinel-framed namespaced key, got ${String(id)}`,
    );
    const framedNs = (id as string).slice(SENTINEL.length).split(SENTINEL)[0]!;
    assert.ok(
      framedNs.startsWith("pi-geek"),
      `every raw-excerpt LCM key must be framed with an authorized pi-geek namespace, got ${String(id)}`,
    );
  }
});

test("#1505 thread NBHWz (codex P2): no readable LCM namespace ⇒ raw excerpts are EMPTY (no throw, no fallback to unreadable default)", async () => {
  // alice authenticates but her policy denies reading `default`, `shared` is not
  // in the recall set, and she has NO readable self namespace
  // (`defaultRecallNamespaces` omits `self` AND her self base is unreadable). No
  // readable LCM namespace exists for an implicit raw recall.
  //
  // FAIL-BEFORE: throws `namespace is not readable: default`. PASS-AFTER: the
  // raw-excerpt lookup is suppressed (returns EMPTY) — `searchContextFull` is
  // never called — so raw recall degrades gracefully instead of throwing.
  const probe = makeRawExcerptProbe({
    config: {
      namespacePolicies: [
        { name: "default", readPrincipals: [], writePrincipals: [] },
        // alice can WRITE but NOT read her self namespace, and self is omitted
        // from the recall set ⇒ nothing readable to fall back to.
        { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
      ],
      // `shared` deliberately not granted either (default policy denies, no
      // shared policy ⇒ canReadNamespace(alice, "shared") is true by the
      // default-or-shared fallback). Omit shared from the recall set so it is not
      // a fallback.
      defaultRecallNamespaces: [],
      codingMode: { projectScope: false, branchScope: false, globalFallback: true },
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
    },
    snapshotNamespace: "default",
    sessionKey: SESSION_KEY,
  });

  // Must NOT throw.
  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    authenticatedPrincipal: "alice",
    disclosure: "raw",
  });

  assert.equal(
    probe.searchSessionIds.length,
    0,
    "no readable LCM namespace ⇒ raw excerpts must be EMPTY (searchContextFull never called), not throw",
  );
});

test("#1505 thread 2f7 (single-store regression): namespaces disabled ⇒ raw excerpts use the raw sessionKey", async () => {
  // Byte-for-byte single-user behavior: no namespaces, no overlay, raw key.
  const probe = makeRawExcerptProbe({
    config: {
      namespacesEnabled: false,
      codingMode: {
        projectScope: false,
        branchScope: false,
        globalFallback: true,
      },
    },
    snapshotNamespace: "default",
    sessionKey: SESSION_KEY,
  });

  await (probe.service as unknown as ExecuteRecallInternals).executeRecall({
    query: "what database are we using?",
    sessionKey: SESSION_KEY,
    disclosure: "raw",
  });

  assert.equal(probe.searchSessionIds.length, 1);
  assert.equal(probe.searchSessionIds[0], SESSION_KEY);
});

test("scope-profile raw excerpts preserve successful sibling LCM keys when one key fails", async () => {
  const probe = makeRawExcerptProbe({
    config: {},
    snapshotNamespace: "default",
    sessionKey: SESSION_KEY,
  });
  const orchestrator = (probe.service as unknown as { orchestrator: Orchestrator }).orchestrator as unknown as {
    lcmEngine: {
      enabled: boolean;
      searchContextFull: (query: string, limit: number, sessionId?: string) => Promise<Array<{
        session_id: string;
        turn_index: number;
        role: string;
        content: string;
      }>>;
    };
  };
  orchestrator.lcmEngine.searchContextFull = async (_query, _limit, sessionId) => {
    probe.searchSessionIds.push(sessionId);
    if (sessionId === "bad") throw new Error("synthetic LCM failure");
    return [
      {
        session_id: sessionId ?? "default",
        turn_index: sessionId === "good" ? 1 : 2,
        role: "user",
        content: `raw row from ${sessionId}`,
      },
    ];
  };

  const excerpts = await (probe.service as unknown as RawExcerptInternals).fetchRawExcerpts("raw", {
    query: "what happened?",
    sessionKey: SESSION_KEY,
    lcmSessionIds: ["good", "bad", "later"],
  });

  assert.deepEqual(probe.searchSessionIds, ["good", "bad", "later"]);
  assert.deepEqual(
    excerpts?.map((excerpt) => [excerpt.sessionId, excerpt.turnIndex, excerpt.content]),
    [
      ["good", 1, "raw row from good"],
      ["later", 2, "raw row from later"],
    ],
  );
});
