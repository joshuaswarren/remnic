/**
 * Cross-namespace LCM read-leak hardening (issue #1505, Codex P1 —
 * "Make LCM session IDs unforgeable across namespaces").
 *
 * Overlay (coding-scope) namespaces archive LCM turns under
 * `${overlayNamespace}:${sessionKey}`, while the DEFAULT store passes the raw,
 * caller-controlled `sessionKey` through VERBATIM as the LCM `session_id`.
 * Namespace names are sanitized to `[A-Za-z0-9._-]` (never contain `:`) and the
 * overlay names are predictable + surfaced via `effectiveNamespace`, so a caller
 * authorized only for the DEFAULT store could forge a raw key shaped like
 * `<other-overlay-ns>:<victim-session>` and read another scope's transcript rows
 * through `lcmSearch` and the raw-disclosure excerpt path.
 *
 * These tests prove, against the real EngramAccessService read surfaces:
 *  - a forged `<overlay-ns>:<victim>` sessionKey / sessionPrefix yields EMPTY
 *    (no LCM query is even issued — no leak);
 *  - a legitimate principal-encoded self key (`pi-geek:abc123`) still reads its
 *    own default-store session (no false positive — the round-3 regression);
 *  - a non-default (overlay) store and namespaces-disabled are UNCHANGED.
 *
 * All fixtures synthetic.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";

type LcmCall = { sessionId?: string; sessionPrefix?: string };

const VICTIM_ROW = {
  id: 1,
  turn_index: 0,
  role: "user",
  content: "alice's project-scoped secret transcript",
  session_id: "alice-project-tag-foo:victim-session",
  score: 0.9,
};

function makeService(
  overrides: Partial<PluginConfig> = {},
): { service: EngramAccessService; calls: LcmCall[] } {
  const calls: LcmCall[] = [];
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orch as unknown as {
    config: PluginConfig;
    lcmEngine: unknown;
  };
  internals.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    memoryDir: "/synthetic/remnic-lcm-forgery",
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;
  // Minimal LCM engine stub: records every read and ALWAYS returns the victim
  // row, so any non-empty result means the read reached another scope's data.
  internals.lcmEngine = {
    enabled: true,
    async searchContextFull(
      _query: string,
      _limit: number,
      sessionId?: string,
      sessionPrefix?: string,
    ) {
      calls.push({ sessionId, sessionPrefix });
      return [VICTIM_ROW];
    },
  };
  return { service: new EngramAccessService(orch), calls };
}

// ── lcmSearch ──────────────────────────────────────────────────────────────

test("lcmSearch: forged overlay-encoded sessionKey on the default store returns EMPTY (no leak)", async () => {
  const { service, calls } = makeService();
  const res = await service.lcmSearch({
    query: "secret",
    sessionKey: "alice-project-tag-foo:victim-session",
  });
  assert.deepEqual(res.results, [], "forged key must not surface another scope's rows");
  assert.equal(res.count, 0);
  assert.equal(res.lcmEnabled, true);
  assert.equal(
    calls.length,
    0,
    "the LCM archive must never be queried with the forged verbatim key",
  );
});

test("lcmSearch: forged overlay-encoded sessionPrefix on the default store returns EMPTY (no leak)", async () => {
  // An authenticated default-store caller pairs a benign sessionKey with a
  // forged LIKE-prefix to enumerate another scope's sessions — the prefix arm
  // of the guard must still suppress it even when the sessionKey is clean.
  const { service, calls } = makeService();
  const res = await service.lcmSearch({
    query: "secret",
    sessionKey: "bob-own-session",
    sessionPrefix: "alice-project-tag-foo",
  });
  assert.deepEqual(res.results, []);
  assert.equal(res.count, 0);
  assert.equal(calls.length, 0, "forged LIKE-prefix must not reach the archive");
});

test("lcmSearch: legitimate principal-encoded self key still reads its own default-store session", async () => {
  // Regression guard (round-3): a principal's own default-store key naturally
  // begins with `<principal>:`. It must pass through verbatim and return rows.
  const { service, calls } = makeService();
  const res = await service.lcmSearch({
    query: "secret",
    sessionKey: "pi-geek:abc123",
  });
  assert.equal(res.count, 1, "the principal must still read its own session");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.sessionId,
    "pi-geek:abc123",
    "the verbatim self key must reach the archive unchanged",
  );
});

test("lcmSearch: a plain bare sessionKey on the default store is unaffected", async () => {
  const { service, calls } = makeService();
  const res = await service.lcmSearch({ query: "secret", sessionKey: "plain-session" });
  assert.equal(res.count, 1);
  assert.equal(calls[0]!.sessionId, "plain-session");
});

test("lcmSearch: namespaces disabled — overlay-shaped key passes through verbatim (single-store unchanged)", async () => {
  // With namespaces disabled there is no overlay encoding: every row lives in
  // the single store under its verbatim sessionKey. The guard must NOT fire.
  const { service, calls } = makeService({ namespacesEnabled: false } as Partial<PluginConfig>);
  const res = await service.lcmSearch({
    query: "secret",
    sessionKey: "alice-project-tag-foo:victim-session",
  });
  assert.equal(res.count, 1, "single-store deployments must be unchanged");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, "alice-project-tag-foo:victim-session");
});

test("lcmSearch: explicit readable overlay namespace + overlay-looking sessionKey is NOT suppressed (prefix isolates it)", async () => {
  // When the caller passes an authorized non-default namespace, the read key is
  // `${namespace}:${sessionKey}` — already non-colliding — so the default-store
  // forgery guard must not fire and break legitimate overlay reads.
  const { service, calls } = makeService({
    namespacePolicies: [
      { name: "alice-project-tag-foo", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  } as Partial<PluginConfig>);
  const res = await service.lcmSearch({
    query: "secret",
    sessionKey: "victim-session",
    namespace: "alice-project-tag-foo",
  });
  assert.equal(res.count, 1, "an authorized overlay-namespace read must still work");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, "alice-project-tag-foo:victim-session");
});

// ── raw-disclosure excerpt path (what recall({disclosure:"raw"}) uses) ───────

function fetchRawExcerpts(
  service: EngramAccessService,
  context: { query: string; sessionKey?: string; namespace?: string; selfBase?: string },
): Promise<Array<{ sessionId: string }> | null> {
  return (
    service as unknown as {
      fetchRawExcerpts: (
        disclosure: "raw",
        ctx: typeof context,
      ) => Promise<Array<{ sessionId: string }> | null>;
    }
  ).fetchRawExcerpts("raw", context);
}

test("recall raw excerpts: forged overlay-encoded sessionKey on the default store returns EMPTY (no leak)", async () => {
  const { service, calls } = makeService();
  const rows = await fetchRawExcerpts(service, {
    query: "secret",
    sessionKey: "alice-project-tag-foo:victim-session",
    namespace: "default",
    selfBase: "default",
  });
  assert.deepEqual(rows, [], "raw-disclosure excerpts must not leak another scope's transcript");
  assert.equal(calls.length, 0, "the LCM archive must never be queried with the forged key");
});

test("recall raw excerpts: legitimate self key still returns its own excerpts (no false positive)", async () => {
  const { service, calls } = makeService();
  const rows = await fetchRawExcerpts(service, {
    query: "secret",
    sessionKey: "pi-geek:abc123",
    namespace: "default",
    selfBase: "pi-geek",
  });
  assert.equal(rows?.length, 1, "the principal must still see its own raw excerpts");
  assert.equal(calls[0]!.sessionId, "pi-geek:abc123");
});

test("recall raw excerpts: namespaces disabled — overlay-shaped key passes through (single-store unchanged)", async () => {
  const { service, calls } = makeService({ namespacesEnabled: false } as Partial<PluginConfig>);
  const rows = await fetchRawExcerpts(service, {
    query: "secret",
    sessionKey: "alice-project-tag-foo:victim-session",
    namespace: "default",
    selfBase: "default",
  });
  assert.equal(rows?.length, 1, "single-store deployments must be unchanged");
  assert.equal(calls.length, 1);
});
