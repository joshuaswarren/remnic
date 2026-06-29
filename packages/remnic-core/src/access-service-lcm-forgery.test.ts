/**
 * #1495 / #1505 P1 (SECURITY): LCM session_id forgery across namespaces.
 *
 * `observe` archives each turn under the LCM `session_id`
 * `lcmSessionKeyForNamespace(effectiveNamespace, sessionKey)`. The LCM archive
 * (SQLite) filters by `session_id` with an EXACT-equality match
 * (`session_id = ?`) and `sessionPrefix` with a LIKE prefix match
 * (`session_id LIKE '<prefix>%'`) — it is keyed by the STRING, NOT physically
 * partitioned by namespace.
 *
 * BEFORE this fix the overlay encoding was `${namespace}:${sessionKey}` and the
 * default-store path returned the RAW `sessionKey` unchanged. That encoding is
 * NOT injective with caller-controlled raw session keys: a caller authorized to
 * read ONLY the `default` store could choose
 *   sessionKey   = "<victim-overlay-ns>:<victim-session>"   (exact-match vector)
 *   sessionPrefix = "<victim-overlay-ns>:"                  (LIKE-prefix vector)
 * which the default-store read path passed through unchanged, producing a
 * `session_id` / prefix that EXACTLY matched the rows the victim archived under
 * its overlay — a CROSS-TENANT READ LEAK.
 *
 * This suite drives a probe whose `searchContextFull` enforces the SAME match
 * semantics as the real SQLite archive (exact `session_id`, LIKE `prefix%`)
 * over a shared row store seeded by the victim's `observe`. It asserts the
 * attacker (authorized for `default` only) retrieves NONE of the victim's
 * overlay rows via `lcmSearch` — both the exact-`session_id` and the
 * `sessionPrefix` forgery vectors — while the legitimate same-principal owner
 * still reads its own rows.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface ArchiveRow {
  session_id: string;
  content: string;
  turn_index: number;
}

interface ForgeryProbe {
  orch: Orchestrator;
  contexts: Map<string, CodingContext>;
  rows: ArchiveRow[];
  searchSessionIds: Array<string | undefined>;
  searchSessionPrefixes: Array<string | undefined>;
}

/**
 * Build a probe whose LCM engine writes/reads a SHARED row store with the SAME
 * match semantics as the production SQLite archive:
 *   - `searchContextFull(query, limit, sessionId, sessionPrefix)`:
 *       * sessionId present   ⇒ rows where `row.session_id === sessionId`
 *       * sessionPrefix present ⇒ rows where `row.session_id.startsWith(prefix)`
 *       * neither              ⇒ ALL rows (archive-wide scan)
 *   - `enqueueObserveMessages(sessionId, messages)`: append one row per message
 *     under that exact `session_id`.
 */
function makeForgeryProbe(overrides: Partial<PluginConfig> = {}): ForgeryProbe {
  const contexts = new Map<string, CodingContext>();
  const rows: ArchiveRow[] = [];
  const searchSessionIds: Array<string | undefined> = [];
  const searchSessionPrefixes: Array<string | undefined> = [];

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-lcm-forgery",
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;

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
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: (
        sessionId: string,
        messages: Array<{ role: string; content: string }>,
      ) => {
        for (let i = 0; i < messages.length; i += 1) {
          rows.push({
            session_id: sessionId,
            content: messages[i]!.content,
            turn_index: i,
          });
        }
      },
      waitForSessionObserveIdle: async (_sessionKey: string) => {},
      preCompactionFlush: async (_sessionKey: string) => {},
      recordCompaction: async () => {},
      // Mirror the real SQLite archive match semantics (archive.ts):
      //   session_id = ?           (exact)
      //   session_id LIKE prefix%  (prefix)
      searchContextFull: async (
        _query: string,
        limit: number,
        sessionId?: string,
        sessionPrefix?: string,
      ) => {
        searchSessionIds.push(sessionId);
        searchSessionPrefixes.push(sessionPrefix);
        let matched = rows;
        if (typeof sessionId === "string") {
          matched = matched.filter((r) => r.session_id === sessionId);
        } else if (typeof sessionPrefix === "string") {
          matched = matched.filter((r) => r.session_id.startsWith(sessionPrefix));
        }
        return matched.slice(0, limit).map((r) => ({
          id: r.turn_index,
          turn_index: r.turn_index,
          role: "assistant",
          content: r.content,
          session_id: r.session_id,
          score: 1,
        }));
      },
    },
    ingestReplayBatch: async () => {},
  } as unknown as Orchestrator;

  return { orch, contexts, rows, searchSessionIds, searchSessionPrefixes };
}

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  return {
    sessionKey: "victim",
    skipExtraction: true,
    messages: [
      { role: "user", content: "what is the secret deploy key?" },
      { role: "assistant", content: "VICTIM SECRET: the deploy key is hunter2" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

const VICTIM_SECRET = "VICTIM SECRET: the deploy key is hunter2";

/**
 * Two principals share the deployment:
 *   - alice: CAN read+write her self namespace (so she gets a project overlay).
 *   - mallory: a caller authorized for the `default` store ONLY (no self policy
 *     entry ⇒ resolves to principal `default`, reads `default`).
 * `default` is readable so mallory passes the implicit-LCM read gate and the
 * read collapses to the default store (raw key) — exactly the path the forgery
 * abuses.
 */
function twoTenantConfig(): Partial<PluginConfig> {
  return {
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      // `default` readable by anyone (the store mallory is authorized for).
      { name: "default", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "alice:", principal: "alice" }],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>;
}

test("#1495 P1 FORGERY BLOCKED: a default-only caller cannot read another tenant's overlay LCM rows via a forged exact session_id", async () => {
  const probe = makeForgeryProbe(twoTenantConfig());
  const service = new EngramAccessService(probe.orch);

  // VICTIM (alice) archives a project-scoped turn under her overlay namespace.
  const victimRes = await service.observe(
    observeRequest({
      sessionKey: "alice:s1",
      projectTag: "Blend/Supply",
    }),
  );
  const victimWriteKey = probe.rows[0]!.session_id;
  const victimOverlayNs = victimRes.effectiveNamespace;
  assert.ok(
    victimOverlayNs && victimOverlayNs.startsWith("alice-"),
    `victim must archive under her overlay namespace, got ${String(victimOverlayNs)}`,
  );
  // Sanity: the victim's own rows are reachable by an exact match on her write key.
  assert.ok(
    probe.rows.some((r) => r.session_id === victimWriteKey),
    "victim rows must be present in the shared archive",
  );

  // ATTACKER (mallory, default-only) forges a raw sessionKey EQUAL to the victim's
  // overlay write key string. Under the OLD encoding the default-store read path
  // returned this raw key unchanged, producing an exact session_id match on the
  // victim's rows.
  const forgedSessionKey = victimWriteKey; // e.g. "alice-project-...:alice:s1"
  const res = await service.lcmSearch({
    query: "secret deploy key",
    sessionKey: forgedSessionKey,
    authenticatedPrincipal: "default",
  });

  const leaked = res.results.some((r) => r.content.includes(VICTIM_SECRET));
  assert.equal(
    leaked,
    false,
    `cross-tenant LEAK: default-only caller read the victim's overlay rows via a forged session_id; results=${JSON.stringify(
      res.results,
    )}`,
  );
  assert.equal(res.count, 0, "forged exact session_id must return NO victim rows");
});

test("#1495 P1 FORGERY BLOCKED: a default-only caller cannot read another tenant's overlay LCM rows via a forged sessionPrefix (LIKE vector)", async () => {
  const probe = makeForgeryProbe(twoTenantConfig());
  const service = new EngramAccessService(probe.orch);

  const victimRes = await service.observe(
    observeRequest({ sessionKey: "alice:s1", projectTag: "Blend/Supply" }),
  );
  const victimOverlayNs = victimRes.effectiveNamespace!;
  assert.ok(victimOverlayNs.startsWith("alice-"));

  // ATTACKER forges a sessionPrefix that, under the old encoding, LIKE-matched all
  // of the victim's overlay rows: "<victim-overlay-ns>:". With NO sessionKey the
  // exact `session_id` filter is absent and the `sessionPrefix` LIKE applies; the
  // default-store read path passed the prefix through unchanged. (Supplying a
  // sessionKey would make the archive use the exact `session_id` filter instead,
  // so the prefix-only form is the true LIKE vector.)
  const res = await service.lcmSearch({
    query: "secret deploy key",
    sessionPrefix: `${victimOverlayNs}:`,
    authenticatedPrincipal: "default",
  });

  const leaked = res.results.some((r) => r.content.includes(VICTIM_SECRET));
  assert.equal(
    leaked,
    false,
    `cross-tenant LEAK via sessionPrefix LIKE: default-only caller matched the victim's overlay rows; results=${JSON.stringify(
      res.results,
    )}`,
  );
});

test("#1495 P1 LEGITIMATE ACCESS PRESERVED: the victim still reads its OWN overlay rows in the same session", async () => {
  const probe = makeForgeryProbe(twoTenantConfig());
  const service = new EngramAccessService(probe.orch);

  // alice archives under her overlay AND binds the coding context to her session.
  await service.observe(
    observeRequest({ sessionKey: "alice:s1", projectTag: "Blend/Supply" }),
  );

  // A same-session lcmSearch by alice (no explicit namespace) must reach her rows:
  // the read resolves the SAME overlay key the write used.
  const res = await service.lcmSearch({
    query: "secret deploy key",
    sessionKey: "alice:s1",
    authenticatedPrincipal: "alice",
  });

  assert.ok(
    res.results.some((r) => r.content.includes(VICTIM_SECRET)),
    `legitimate same-principal same-session read must still return alice's own rows; results=${JSON.stringify(
      res.results,
    )}`,
  );
});

test("#1495 P1 LEGITIMATE ACCESS PRESERVED: a session key that legitimately contains ':' still reads its own rows (single store, no overlay)", async () => {
  // Single-user / no-overlay deployment: the raw sessionKey is used verbatim as
  // the LCM key, including embedded ':'. The owner must still read its own rows.
  const probe = makeForgeryProbe({
    namespacesEnabled: false,
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({ sessionKey: "agent:proj:sess-1", skipExtraction: true }),
  );
  // No overlay ⇒ raw key archived verbatim.
  assert.equal(probe.rows[0]!.session_id, "agent:proj:sess-1");

  const res = await service.lcmSearch({
    query: "secret deploy key",
    sessionKey: "agent:proj:sess-1",
  });
  assert.ok(
    res.results.some((r) => r.content.includes(VICTIM_SECRET)),
    `single-store owner with a ':'-bearing session key must read its own rows; results=${JSON.stringify(
      res.results,
    )}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// #1505 codex P1 (round 2): a SESSIONLESS + prefixless `lcmSearch` issues
// `searchContextFull(query, limit, undefined, undefined)` — an archive-wide FTS
// scan over EVERY `session_id`, including sentinel-framed overlay rows. The
// archive is keyed by `session_id`, NOT partitioned by namespace, so an
// unscoped scan cannot be constrained to the caller's authorized namespace.
// When namespaces are ENABLED it must therefore be SUPPRESSED regardless of an
// explicit `namespace` or default-readability; only single-store (namespaces
// disabled) keeps the legitimate archive-wide scan.
// ──────────────────────────────────────────────────────────────────────────

test("#1505 codex P1 r2 FORGERY BLOCKED: explicit-namespace + sessionless lcmSearch does NOT archive-scan another tenant's overlay rows", async () => {
  const probe = makeForgeryProbe(twoTenantConfig());
  const service = new EngramAccessService(probe.orch);

  // VICTIM archives overlay rows.
  const victimRes = await service.observe(
    observeRequest({ sessionKey: "alice:s1", projectTag: "Blend/Supply" }),
  );
  assert.ok(victimRes.effectiveNamespace!.startsWith("alice-"));

  // ATTACKER reads an explicit namespace they ARE authorized for (`default`),
  // with NO sessionKey/sessionPrefix. The underlying search would be an
  // archive-wide scan (no session_id filter), exposing alice's overlay rows.
  const res = await service.lcmSearch({
    query: "secret deploy key",
    namespace: "default",
    authenticatedPrincipal: "default",
  });

  assert.equal(
    res.results.some((r) => r.content.includes(VICTIM_SECRET)),
    false,
    `cross-tenant LEAK via explicit-namespace archive scan; results=${JSON.stringify(res.results)}`,
  );
  assert.equal(res.count, 0, "explicit-namespace sessionless lcmSearch must NOT archive-scan");
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "searchContextFull must NOT run an unscoped archive scan when namespaces are enabled",
  );
});

test("#1505 codex P1 r2 FORGERY BLOCKED: default-readable implicit + sessionless lcmSearch does NOT archive-scan overlay rows", async () => {
  const probe = makeForgeryProbe(twoTenantConfig());
  const service = new EngramAccessService(probe.orch);

  const victimRes = await service.observe(
    observeRequest({ sessionKey: "alice:s1", projectTag: "Blend/Supply" }),
  );
  assert.ok(victimRes.effectiveNamespace!.startsWith("alice-"));

  // ATTACKER (default-readable) with NO sessionKey/namespace/sessionPrefix. The
  // pre-fix guard allowed this through to an archive-wide scan.
  const res = await service.lcmSearch({
    query: "secret deploy key",
    authenticatedPrincipal: "default",
  });

  assert.equal(
    res.results.some((r) => r.content.includes(VICTIM_SECRET)),
    false,
    `cross-tenant LEAK via default-readable archive scan; results=${JSON.stringify(res.results)}`,
  );
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "searchContextFull must NOT run an unscoped archive scan when namespaces are enabled",
  );
});

test("#1505 codex P1 r2 regression: single-store (namespaces disabled) + sessionless lcmSearch STILL archive-scans (byte-for-byte prior behavior)", async () => {
  const probe = makeForgeryProbe({
    namespacesEnabled: false,
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // Single-store: one shared archive owned by the caller. Seed a row, then a
  // sessionless search must still scan it.
  await service.observe(
    observeRequest({ sessionKey: "owner-sess", skipExtraction: true }),
  );
  const res = await service.lcmSearch({ query: "secret deploy key" });

  assert.equal(
    probe.searchSessionIds.length,
    1,
    "namespaces disabled ⇒ sessionless archive scan still runs",
  );
  assert.equal(probe.searchSessionIds[0], undefined, "archive-wide scan passes no session_id filter");
  assert.ok(
    res.results.some((r) => r.content.includes(VICTIM_SECRET)),
    "single-store owner still reads its archive",
  );
});
