import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "../types.js";

import { StorageManager } from "../index.js";
import { parseConfig } from "../config.js";
import { createBatchPromotedCopyProbe, mergeTargetHasPromotedCopies, promoteAndReconcileMergedTarget, retireStaleMergedTargetPromotionCopies } from "./extraction-persist-promotion.js";
import { buildMergedTargetPromotionPayload, type MergedTargetPromotionPayload } from "./semantic-merge-promotion-payload.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";

// Synthetic fixtures only — no real paths, hosts, or memory content.
const PROMOTED_BODY = "Promoted copy of the billing deploy cadence fact.";

async function makeStorages(): Promise<{
  source: StorageManager;
  shared: StorageManager;
  router: { storageFor: (namespace: string) => Promise<StorageManager> };
}> {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const shared = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-shared-")));
  await source.ensureDirectories();
  await shared.ensureDirectories();
  const router = {
    storageFor: async (namespace: string): Promise<StorageManager> => {
      if (namespace === "shared") return shared;
      throw new Error(`unexpected namespace "${namespace}"`);
    },
  };
  return { source, shared, router };
}

function argsFor(overrides: {
  source: StorageManager;
  router: { storageFor: (namespace: string) => Promise<StorageManager> };
  failRouter?: boolean;
}) {
  return {
    config: parseConfig({ memoryDir: overrides.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () =>
      overrides.failRouter === true
        ? {
            storageFor: (_namespace: string) =>
              Promise.reject(new Error("router down")),
          }
        : overrides.router,
    scopeProfileWritePlan: null,
    sourceStorage: overrides.source,
    targetMemoryId: "fact-target",
  };
}

test("mergeTargetHasPromotedCopies: a shared copy linked by sourceMemoryId blocks the merge", async () => {
  const s = await makeStorages();
  const unrelated = await s.shared.writeMemory("fact", PROMOTED_BODY, { source: "test" });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    false,
    "an unrelated shared fact (no sourceMemoryId) must not block",
  );
  await s.shared.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    true,
    `a shared copy linked to the target must block (unrelated copy id: ${unrelated.id})`,
  );
});

test("mergeTargetHasPromotedCopies: a copy in the source namespace itself does not block", async () => {
  const s = await makeStorages();
  await s.source.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    false,
    "the target's own namespace holds the source row, not a promoted copy",
  );
});

test("mergeTargetHasPromotedCopies: an unreadable promotion namespace fails safe (blocks the merge)", async () => {
  const s = await makeStorages();
  assert.equal(
    await mergeTargetHasPromotedCopies(
      argsFor({ source: s.source, router: s.router, failRouter: true }),
    ),
    true,
    "an unreadable namespace may hold a copy we cannot see — create instead",
  );
});

test("mergeTargetHasPromotedCopies: a shared copy still blocks when shared-write authorization is revoked", async () => {
  // The copy was promoted while shared writes were allowed; the profile has
  // since lost that authorization. Current write authorization must not
  // make an existing copy invisible to the scan — the merge is bypassed so
  // the shared copy cannot keep serving the pre-merge body.
  const s = await makeStorages();
  await s.shared.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    true,
    "a historical shared copy blocks even though no authorization gate is consulted",
  );
});

test("mergeTargetHasPromotedCopies: an unauthorized profile target's historical copy still blocks", async () => {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const team = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-team-")));
  await source.ensureDirectories();
  await team.ensureDirectories();
  await team.writeMemory("fact", PROMOTED_BODY, { source: "test", sourceMemoryId: "fact-target" });
  const args = {
    ...argsFor({
      source,
      router: {
        storageFor: async (namespace: string) => {
          if (namespace === "team" || namespace === "shared") return team;
          throw new Error(`unexpected namespace "${namespace}"`);
        },
      },
    }),
    scopeProfileWritePlan: {
      profileId: "synthetic",
      profile: { autoPromote: { targets: ["team-project"] } },
      promotionTargets: [
        // Authorized NOW: false — the copy was promoted under an older plan.
        { target: "team-project", namespace: "team", authorized: false, reason: "revoked" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  };
  assert.equal(
    await mergeTargetHasPromotedCopies(args),
    true,
    "current authorization must not drop a known promotion layer from the scan",
  );
});

test("mergeTargetHasPromotedCopies: a layer removed from today's autoPromote targets still blocks (finding E)", async () => {
  // The copy was promoted while the layer was listed in autoPromote.targets;
  // the operator has since removed it. The layer is still a resolved
  // promotionTarget, so historical-copy detection must keep scanning it —
  // today's selection policy must not blind the scan.
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const team = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-team-")));
  await source.ensureDirectories();
  await team.ensureDirectories();
  await team.writeMemory("fact", PROMOTED_BODY, { source: "test", sourceMemoryId: "fact-target" });
  const args = {
    ...argsFor({
      source,
      router: {
        storageFor: async (namespace: string) => {
          if (namespace === "team" || namespace === "shared") return team;
          throw new Error(`unexpected namespace "${namespace}"`);
        },
      },
    }),
    scopeProfileWritePlan: {
      profileId: "synthetic",
      profile: { autoPromote: { targets: [] } },
      promotionTargets: [
        { target: "team-project", namespace: "team", authorized: true, reason: "ok" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  };
  assert.equal(
    await mergeTargetHasPromotedCopies(args),
    true,
    "a copy on a deselected layer still blocks — detection scans history, policy governs writes",
  );
});

test("createBatchPromotedCopyProbe: one scan per namespace per batch, not per fact (finding F)", async () => {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const team = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-team-")));
  const shared = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-shared-")));
  await source.ensureDirectories();
  await team.ensureDirectories();
  await shared.ensureDirectories();
  await team.writeMemory("fact", PROMOTED_BODY, { source: "test", sourceMemoryId: "fact-target" });
  let storageForCalls = 0;
  const probe = createBatchPromotedCopyProbe(
    parseConfig({ memoryDir: source.dir, sharedNamespace: "shared" }),
    () => ({
      storageFor: async (namespace: string) => {
        storageForCalls++;
        if (namespace === "team") return team;
        if (namespace === "shared") return shared;
        throw new Error(`unexpected namespace "${namespace}"`);
      },
    }),
    {
      profileId: "synthetic",
      profile: { autoPromote: { targets: ["team-project"] } },
      promotionTargets: [
        { target: "team-project", namespace: "team", authorized: true, reason: "ok" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  );
  // Three judge-approved facts in one batch, each probing the same target:
  // every probe must see the historical copy, and the team corpus scan must
  // have run exactly once (the hit short-circuits before shared).
  for (let factIndex = 0; factIndex < 3; factIndex++) {
    assert.equal(
      await probe.check(source, "fact-target"),
      true,
      `fact ${factIndex}: the historical copy must block`,
    );
  }
  assert.equal(storageForCalls, 1, "the team namespace scanned once — not once per fact");
  // A fact with no copy anywhere probes PAST team into shared, once:
  assert.equal(await probe.check(source, "fact-without-copy"), false);
  assert.equal(await probe.check(source, "fact-without-copy"), false);
  assert.equal(storageForCalls, 2, "the shared namespace also scanned once per batch");
  // A promotion this batch performed must force the next fact to rescan.
  probe.invalidate();
  assert.equal(await probe.check(source, "fact-target"), true);
  assert.equal(storageForCalls, 3, "invalidation drops the cache; the next fact rescans");
});

test("retireStaleMergedTargetPromotionCopies: a concurrent promotion of the pre-merge body is reconciled to the current copy (round N+7 B)", async () => {
  // Race being modeled: the pre-mutation promoted-copy probe reported none,
  // another writer promoted the PRE-merge body, and only then did the merge
  // commit and promote the current body. Promotion dedups by content, so
  // without reconciliation both copies stay active across namespaces. The
  // helper is imported dynamically so the PRE-fix run fails this test alone
  // (the reconciliation being absent) instead of failing the whole file at
  // import time.
  const { retireStaleMergedTargetPromotionCopies } = await import(
    "./extraction-persist-promotion.js"
  );
  assert.equal(
    typeof retireStaleMergedTargetPromotionCopies,
    "function",
    "the merged-target promotion reconciliation must exist",
  );
  const s = await makeStorages();
  const PRE_MERGE_BODY = "Billing service deploys happen on Tuesdays.";
  const MERGED_BODY = "Billing service deploys happen on Tuesdays at 09:00 UTC.";
  // The committed source record holds the merged body — the canonical
  // record reconciliation re-reads (round N+15 A: always, not only when no
  // promoted body is supplied).
  const target = await s.source.writeMemory("fact", MERGED_BODY, {
    source: "test",
  });
  // The concurrent writer's copy: same sourceMemoryId, pre-merge body.
  const stale = await s.shared.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    sourceMemoryId: target.id,
  });
  // The merged-target promotion's copy: same sourceMemoryId, merged body.
  const current = await s.shared.writeMemory("fact", MERGED_BODY, {
    source: "test",
    sourceMemoryId: target.id,
  });
  const retired = await retireStaleMergedTargetPromotionCopies({
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    promotedContent: MERGED_BODY,
    promotedMemoryId: current.id,
    normalize: (content: string) => content,
  });
  assert.equal(retired, 1, "exactly the pre-merge copy is retired");
  const staleRow = await s.shared.getMemoryByIdIncludingArchived(stale.id);
  assert.equal(staleRow?.frontmatter.status, "superseded");
  assert.equal(staleRow?.frontmatter.supersededBy, current.id);
  const currentRow = await s.shared.getMemoryByIdIncludingArchived(current.id);
  assert.equal(currentRow?.frontmatter.status ?? "active", "active");
});

test("retireStaleMergedTargetPromotionCopies: an unreadable canonical record aborts reconciliation — no copy is retired (round N+13 A)", async () => {
  // No-promotion path: the committed source record is re-read to serve as
  // the canonical body. When that re-read fails transiently, returns nothing,
  // or yields an empty body, there is NO confirmed replacement body to
  // compare against — an empty-string fallback would classify every
  // non-empty active copy as stale and supersede it (keep-vs-destroy guard:
  // unreadable input resolves toward keep). Reconciliation aborts; the next
  // merge retries it.
  const s = await makeStorages();
  const copy = await s.shared.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  const cases: Array<{ label: string; read: () => Promise<MemoryFile | null> }> = [
    {
      label: "transient read failure",
      read: async () => {
        throw new Error("transient canonical read failure");
      },
    },
    { label: "record not found", read: async () => null },
    {
      label: "record with empty body",
      read: async () =>
        ({
          path: `${s.source.dir}/facts/2026-08-20/fact-target.md`,
          frontmatter: { id: "fact-target", category: "fact" },
          content: "",
        }) as unknown as MemoryFile,
    },
  ];
  for (const testCase of cases) {
    const readSpy = mock.method(s.source, "getMemoryByIdIncludingArchived", testCase.read);
    try {
      const retired = await retireStaleMergedTargetPromotionCopies({
        config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
        getStorageRouter: () => s.router,
        scopeProfileWritePlan: null,
        sourceStorage: s.source,
        sourceMemoryId: "fact-target",
        normalize: (content: string) => content,
      });
      assert.equal(
        retired,
        0,
        `${testCase.label}: no copy may be retired without a confirmed canonical body`,
      );
    } finally {
      readSpy.mock.restore();
    }
    const row = await s.shared.getMemoryByIdIncludingArchived(copy.id);
    assert.equal(
      row?.frontmatter.status ?? "active",
      "active",
      `${testCase.label}: the promoted copy stays active`,
    );
  }
});

test("former promotion layers still resolvable are scanned: a copy on a layer removed from promotionTargets is detected and reconciled (round N+12 B)", async () => {
  // The namespace received promoted copies while "userGlobal" was listed in
  // profile.promotionTargets. The operator has since removed the layer from
  // the promotion selection, but it remains resolvable through the plan's
  // layers (readOrder). Historical copies there must stay detectable — and
  // reconcilable — or that namespace keeps serving the stale pre-merge body.
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const global = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-global-")));
  const shared = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-shared-")));
  await source.ensureDirectories();
  await global.ensureDirectories();
  await shared.ensureDirectories();
  const PRE_MERGE_BODY = "Billing service deploys happen on Tuesdays.";
  const MERGED_BODY = "Billing service deploys happen on Tuesdays at 09:00 UTC.";
  // The committed source record (canonical for reconciliation, N+15 A).
  const target = await source.writeMemory("fact", MERGED_BODY, { source: "test" });
  const stale = await global.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    sourceMemoryId: target.id,
  });
  const router = {
    storageFor: async (namespace: string): Promise<StorageManager> => {
      if (namespace === "global" || namespace === "shared") {
        return namespace === "global" ? global : shared;
      }
      throw new Error(`unexpected namespace "${namespace}"`);
    },
  };
  const plan = {
    profileId: "synthetic",
    profile: { autoPromote: { targets: [] } },
    // The layer is GONE from today's promotion targets...
    promotionTargets: [],
    // ...but still resolvable through the plan's resolved layers.
    layers: [{ id: "userGlobal", namespace: "global" }],
  } as unknown as ResolvedScopeProfilePlan;
  const config = parseConfig({ memoryDir: source.dir, sharedNamespace: "shared" });
  // Detection: the probe must still find the historical copy there.
  assert.equal(
    await mergeTargetHasPromotedCopies({
      config,
      getStorageRouter: () => router,
      scopeProfileWritePlan: plan,
      sourceStorage: source,
      targetMemoryId: target.id,
    }),
    true,
    "a copy on a former-but-still-resolvable promotion layer must block the merge",
  );
  // Reconciliation: after a merge, the stale copy there is superseded.
  const retired = await retireStaleMergedTargetPromotionCopies({
    config,
    getStorageRouter: () => router,
    scopeProfileWritePlan: plan,
    sourceStorage: source,
    sourceMemoryId: target.id,
    promotedContent: MERGED_BODY,
    normalize: (content: string) => content,
  });
  assert.equal(retired, 1, "the stale copy on the former layer is retired");
  const staleRow = await global.getMemoryByIdIncludingArchived(stale.id);
  assert.equal(staleRow?.frontmatter.status, "superseded");
  assert.equal(staleRow?.frontmatter.supersededBy, target.id);
});

// ── Round N+15 (A): multi-writer promotion races ────────────────────────────

const PRE_MERGE_BODY = "Billing service deploys happen on Tuesdays.";
const A_MERGED_BODY = "Billing service deploys happen on Tuesdays at 09:00 UTC.";
const B_MERGED_BODY =
  "Billing service deploys happen on Tuesdays at 09:00 UTC, paging the on-call engineer.";

async function commitWriterMerge(
  storage: StorageManager,
  targetId: string,
  body: string,
): Promise<void> {
  const snapshot = await storage.getMemoryByIdIncludingArchived(targetId);
  assert.ok(snapshot);
  assert.ok(await storage.updateMemoryIfUnchanged(snapshot, body));
}

test("promoteAndReconcileMergedTarget: abandons the cached promotion when the target advanced past it (round N+15 A)", async () => {
  // Race: writer A built its promotion payload from the committed record,
  // then writer B merged the SAME target again and published its copy
  // before A resumed at the promotion. Promoting A's cached older body
  // would hand reconciliation a stale canonical body that supersedes B's
  // current copy. A must abandon the promotion AND its reconciliation —
  // B's copy stands; the next merge retries both.
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  // Writer B merges the same target again and publishes its newer copy.
  await commitWriterMerge(s.source, target.id, B_MERGED_BODY);
  const bCopy = await s.shared.writeMemory("fact", B_MERGED_BODY, {
    source: "writer-b",
    sourceMemoryId: target.id,
  });

  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    normalize: (content: string) => content,
  });
  assert.equal(promotions, 0, "the stale cached payload must never be promoted");
  const bRow = await s.shared.getMemoryByIdIncludingArchived(bCopy.id);
  assert.equal(
    bRow?.frontmatter.status ?? "active",
    "active",
    "the newer writer's current copy stands",
  );
});

test("promoteAndReconcileMergedTarget: reconciliation canonical is the re-read record, never the cached promoted body (round N+15 A)", async () => {
  // The residual window: the payload revalidates clean, the promotion
  // writes, and ONLY THEN does writer B commit a newer merge and publish
  // its copy — before A's reconciliation runs. A cached-body canonical
  // would supersede B's current copy; the re-read committed record is the
  // only body reconciliation may treat as canonical.
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);

  let aCopyId = "";
  let bCopyId = "";
  await promoteAndReconcileMergedTarget({
    promote: async (promotionPayload) => {
      const aCopy = await s.shared.writeMemory("fact", promotionPayload.content, {
        source: "writer-a",
        sourceMemoryId: target.id,
      });
      aCopyId = aCopy.id;
      // Writer B's second merge lands HERE — after the promotion wrote,
      // before reconciliation runs.
      await commitWriterMerge(s.source, target.id, B_MERGED_BODY);
      const bCopy = await s.shared.writeMemory("fact", B_MERGED_BODY, {
        source: "writer-b",
        sourceMemoryId: target.id,
      });
      bCopyId = bCopy.id;
      return aCopy.id;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    normalize: (content: string) => content,
  });
  const bRow = await s.shared.getMemoryByIdIncludingArchived(bCopyId);
  assert.equal(
    bRow?.frontmatter.status ?? "active",
    "active",
    "B's current copy is never superseded off A's cached body",
  );
  const aRow = await s.shared.getMemoryByIdIncludingArchived(aCopyId);
  assert.equal(
    aRow?.frontmatter.status,
    "superseded",
    "A's raced copy retires once the committed record moved past its body",
  );
  assert.equal(
    aRow?.frontmatter.supersededBy,
    target.id,
    "the supersession lands on the source target — the live canonical record",
  );
});

test("promoteAndReconcileMergedTarget: an unreadable payload skips destructive reconciliation (#2807)", async () => {
  // The payload builder's post-commit reread failed TRANSIENTLY (secure
  // store locked, corpus read I/O error). A null from that path means
  // "payload unknown", not "no promotion warranted" — but the caller
  // conflated both, so reconciliation immediately reread successfully,
  // interpreted the missing payload as an intentional no-promotion result,
  // and superseded a concurrent writer's PRE-merge copy with no
  // current-body replacement, removing an otherwise eligible memory from
  // the shared layer. An unknown payload must skip the destructive pass;
  // the next merge retries both.
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  // A concurrent writer published the PRE-merge body after the initial
  // guard — the exact race reconciliation exists to clean up, but ONLY
  // once the no-promotion outcome is confirmed intentional.
  const staleCopy = await s.shared.writeMemory("fact", PRE_MERGE_BODY, {
    source: "writer-b",
    sourceMemoryId: target.id,
  });
  let reads = 0;
  const lockedThenRecovered = {
    dir: s.source.dir,
    getMemoryByIdIncludingArchived: async (id: string) => {
      reads += 1;
      if (reads === 1) throw new Error("secure store locked");
      return s.source.getMemoryByIdIncludingArchived(id);
    },
  } as unknown as StorageManager;
  const built = (await buildMergedTargetPromotionPayload(lockedThenRecovered, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  })) as { payload: MergedTargetPromotionPayload | null; readFailed?: boolean } | null;
  // Pre-#2807 the builder returned a bare null; the result object now
  // preserves WHY. This normalization keeps the test runnable against
  // both shapes.
  const payload = built === null ? null : built.payload;
  const readFailed = built !== null && built.readFailed === true;
  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    mergedPromotionReadFailed: readFailed,
    normalize: (content: string) => content,
  });
  assert.equal(promotions, 0, "an unreadable payload promotes nothing");
  const row = await s.shared.getMemoryByIdIncludingArchived(staleCopy.id);
  assert.equal(
    row?.frontmatter.status ?? "active",
    "active",
    "an unconfirmed no-promotion outcome must never retire copies — the next merge retries promotion and reconciliation",
  );
});

function casShardPath(storageDir: string, memoryPath: string): string {
  const relative = path.relative(storageDir, memoryPath).split(path.sep).join("/");
  const hash = createHash("sha256").update(relative).digest("hex");
  return path.join(storageDir, ".offline-sync", "cas-revisions", `${hash}.json`);
}

test("buildMergedTargetPromotionPayload: an unreadable CAS receipt shard refuses the promotion (#2813 P1 A)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, { source: "test" });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const committedRow = await s.source.getMemoryByIdIncludingArchived(target.id);
  assert.ok(committedRow);
  const shardPath = casShardPath(s.source.dir, committedRow.path);
  // Prove a real standing receipt existed before tearing the shard.
  const shard = JSON.parse(await readFile(shardPath, "utf8")) as { revision?: string };
  assert.ok(shard.revision, "the merge commit minted a standing receipt");
  await writeFile(shardPath, "{corrupt", "utf8");

  // A concurrent writer published the PRE-merge body after the initial
  // guard — reconciliation may retire it ONLY off a confirmed outcome.
  const staleCopy = await s.shared.writeMemory("fact", PRE_MERGE_BODY, {
    source: "writer-b",
    sourceMemoryId: target.id,
  });
  const built = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.equal(built.payload, null, "an unreadable receipt must refuse the promotion");
  assert.equal(built.readFailed, true, "the refusal is an unknown outcome, not a no-promotion verdict");

  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: built.payload,
    mergedPromotionReadFailed: built.readFailed,
    normalize: (content) => content,
  });
  assert.equal(promotions, 0, "nothing is promoted off an unconfirmable receipt");
  const row = await s.shared.getMemoryByIdIncludingArchived(staleCopy.id);
  assert.equal(
    row?.frontmatter.status ?? "active",
    "active",
    "no destructive reconciliation runs off an unknown payload",
  );
});

test("promoteAndReconcileMergedTarget: a receipt that becomes unreadable before the promotion abandons it (#2813 P1 A)", async () => {
  const s = await makeStorages();
  // Fresh target, never minted: the payload legitimately carries no token.
  const target = await s.source.writeMemory("fact", A_MERGED_BODY, { source: "test" });
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  assert.equal(payload.committedRevision, undefined, "a genuinely absent receipt builds a tokenless payload");
  // A torn shard write lands between build and promotion: absence became
  // UNREADABLE, and the old undefined-vs-undefined comparison would have
  // confirmed the cached body anyway.
  const committedRow = await s.source.getMemoryByIdIncludingArchived(target.id);
  assert.ok(committedRow);
  const tornShardPath = casShardPath(s.source.dir, committedRow.path);
  await mkdir(path.dirname(tornShardPath), { recursive: true });
  await writeFile(tornShardPath, "{corrupt", "utf8");

  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    normalize: (content) => content,
  });
  assert.equal(promotions, 0, "an unreadable standing receipt must not confirm the cached payload");
});

test("promoteAndReconcileMergedTarget: a genuinely absent receipt still confirms and promotes (#2813 P1 A)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", A_MERGED_BODY, { source: "test" });
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  assert.equal(payload.committedRevision, undefined, "a pre-sidecar target promotes without a token");

  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async (promotionPayload) => {
      promotions += 1;
      assert.equal(promotionPayload.content, A_MERGED_BODY);
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    normalize: (content) => content,
  });
  assert.equal(promotions, 1, "absent-versus-absent confirms — pre-sidecar records keep their promotion semantics");
});
test("buildMergedTargetPromotionPayload and promotion refuse when interleaving writer updates metadata with same body (#2813 P1 B)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, { source: "test", confidence: 0.5 });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  assert.ok(payload.committedRevision);
  assert.ok(payload.committedDigest);

  // Interleaving writer updates metadata with the SAME body/content:
  assert.ok(await s.source.updateMemoryFrontmatter(target.id, { confidence: 0.95 }));

  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: target.id,
    mergedPromotion: payload,
    normalize: (content) => content,
  });
  assert.equal(
    promotions,
    0,
    "promotion must be abandoned when standing receipt digest/revision changes due to same-body metadata update",
  );
});

// ── #2870: access-only telemetry vs semantic metadata in the promotion binding ──

type RawFileMutator = (raw: string) => string;

const withFrontmatterLine = (line: string): RawFileMutator => (raw) =>
  raw.replace("\n---\n", `\n${line}\n---\n`);

/** Rewrite the durable file directly — a writer that changes semantics
 * WITHOUT minting a CAS receipt (hand edit, legacy tool). Exactly the
 * writer class the semantic-fingerprint clause must catch. */
async function rewriteDurableWithoutReceipt(
  storage: StorageManager,
  memoryId: string,
  mutate: RawFileMutator,
): Promise<void> {
  const row = await storage.getMemoryByIdIncludingArchived(memoryId);
  assert.ok(row);
  const before = await readFile(row.path, "utf8");
  await writeFile(row.path, mutate(before), "utf8");
}
async function flushAccess(
  storage: StorageManager,
  memoryId: string,
  newCount: number,
): Promise<number> {
  return await storage.flushAccessTracking([
    { memoryId, newCount, lastAccessed: "2026-08-23T00:00:00.000Z" },
  ]);
}

async function runPromotion(
  s: { source: StorageManager; router: { storageFor: (namespace: string) => Promise<StorageManager> } },
  payload: MergedTargetPromotionPayload | null,
  sourceMemoryId: string,
): Promise<number> {
  let promotions = 0;
  await promoteAndReconcileMergedTarget({
    promote: async () => {
      promotions += 1;
      return `copy-${promotions}`;
    },
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId,
    mergedPromotion: payload,
    normalize: (content: string) => content,
  });
  return promotions;
}

test("access flush between merge commit and payload build still promotes (#2870)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    confidence: 0.5,
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const committed = await s.source.getMemoryByIdIncludingArchived(target.id);
  assert.ok(committed);
  const shardPath = casShardPath(s.source.dir, committed.path);
  const receiptBefore = JSON.parse(await readFile(shardPath, "utf8")) as { revision: string };
  const bytesBefore = await readFile(committed.path, "utf8");

  assert.equal(await flushAccess(s.source, target.id, 3), 1, "the access flush landed");

  // Prove the interleaving is real: bytes changed, receipt did not re-mint.
  assert.notEqual(await readFile(committed.path, "utf8"), bytesBefore, "the flush rewrote the durable file");
  const receiptAfter = JSON.parse(await readFile(shardPath, "utf8")) as { revision: string };
  assert.equal(receiptAfter.revision, receiptBefore.revision, "an access flush mints no receipt");

  const { payload, readFailed } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.equal(readFailed, false);
  assert.ok(payload, "an access-only flush must not refuse the payload");
  assert.ok(payload?.committedSemanticFingerprint, "the payload carries the semantic binding");

  assert.equal(await runPromotion(s, payload, target.id), 1, "the flushed-but-unchanged semantics still promote");
});

test("access flush between payload build and promotion still promotes (#2870)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    confidence: 0.5,
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  assert.equal(await flushAccess(s.source, target.id, 7), 1, "the access flush lands after the build");

  assert.equal(await runPromotion(s, payload, target.id), 1, "the final guard confirms the flushed record's semantics");
});

test("payload build refuses a semantic mutation that minted no receipt (#2870)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    confidence: 0.5,
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  await rewriteDurableWithoutReceipt(
    s.source,
    target.id,
    (raw) => raw.replace(/^confidence: .*$/m, "confidence: 0.99"),
  );
  const { payload, readFailed } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.equal(payload, null, "a same-body confidence change must refuse the payload");
  assert.equal(readFailed, true, "the refusal is an unknown outcome, not a no-promotion verdict");
});

test("final guard refuses each semantic field mutation that minted no receipt (#2870)", async () => {
  const mutations: Array<[label: string, mutate: RawFileMutator]> = [
    ["confidence", (raw) => raw.replace(/^confidence: .*$/m, "confidence: 0.99")],
    ["tags", (raw) => raw.replace(/^tags: .*$/m, 'tags: ["mutated"]')],
    ["status", withFrontmatterLine("status: superseded")],
    ["provenance", withFrontmatterLine("provenance: unverified")],
    ["tool scope", withFrontmatterLine("toolScoped: true")],
    ["body", (raw) => `${raw}\nmutated body suffix`],
  ];
  for (const [label, mutate] of mutations) {
    const s = await makeStorages();
    const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
      source: "test",
      confidence: 0.5,
    });
    await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
    const { payload } = await buildMergedTargetPromotionPayload(s.source, {
      targetId: target.id,
      mergedContent: A_MERGED_BODY,
      provenancePatched: true,
    });
    assert.ok(payload, `payload builds before the ${label} mutation`);
    await rewriteDurableWithoutReceipt(s.source, target.id, mutate);

    assert.equal(
      await runPromotion(s, payload, target.id),
      0,
      `a ${label} mutation without a receipt must refuse promotion`,
    );
  }
});

test("a PENDING receipt marker between build and promotion abandons it (#2870)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    confidence: 0.5,
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const { payload } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.ok(payload);
  const committed = await s.source.getMemoryByIdIncludingArchived(target.id);
  assert.ok(committed);
  const shardPath = casShardPath(s.source.dir, committed.path);
  const relative = path.relative(s.source.dir, committed.path).split(path.sep).join("/");
  // A pending marker whose expected digest matches nothing: lazy recovery
  // cannot decide it, so the receipt reads UNAVAILABLE and the promotion
  // must refuse rather than confirm against an unknown identity.
  await writeFile(
    shardPath,
    `${JSON.stringify({
      version: 1,
      path: relative,
      revision: "2026-08-23T00:00:00.001Z",
      state: "pending",
      previous: payload.committedRevision ?? "2026-08-23T00:00:00.000Z",
      baselineDigest: "0".repeat(64),
      expectedDigest: "1".repeat(64),
    })}\n`,
    "utf8",
  );

  assert.equal(
    await runPromotion(s, payload, target.id),
    0,
    "a pending (recovery-needed) receipt must not confirm the payload",
  );
});

test("a legacy shard without a stored semantic fingerprint keeps the conservative digest refusal (#2870)", async () => {
  const s = await makeStorages();
  const target = await s.source.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    confidence: 0.5,
  });
  await commitWriterMerge(s.source, target.id, A_MERGED_BODY);
  const committed = await s.source.getMemoryByIdIncludingArchived(target.id);
  assert.ok(committed);
  // Downgrade the shard to its pre-#2870 shape: committed digest, no
  // semantic fingerprint.
  const shardPath = casShardPath(s.source.dir, committed.path);
  const shard = JSON.parse(await readFile(shardPath, "utf8")) as Record<string, unknown>;
  delete shard.committedSemanticFingerprint;
  await writeFile(shardPath, `${JSON.stringify(shard)}\n`, "utf8");

  assert.equal(await flushAccess(s.source, target.id, 4), 1, "the access flush lands on the legacy shard");
  const { payload, readFailed } = await buildMergedTargetPromotionPayload(s.source, {
    targetId: target.id,
    mergedContent: A_MERGED_BODY,
    provenancePatched: true,
  });
  assert.equal(payload, null, "legacy shards keep the full-digest binding until the next semantic write");
  assert.equal(readFailed, true);
});
