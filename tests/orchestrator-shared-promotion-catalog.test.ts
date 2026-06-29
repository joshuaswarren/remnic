import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

// ── Round 2, Issue B (cursor[bot] Medium): a shared-namespace promotion writes
// to the shared namespace via `sharedStorage.writeMemory`, but round 1 only
// recorded `markCatalogWrite` for the routed SOURCE namespace. When promotion is
// the only write the shared namespace receives, its catalog `lastWriteAt` stayed
// stale — skewing `writtenSince` filters and maintenance fanout. The orchestrator
// now fires `markCatalogWrite(sharedNamespace, sharedStorage.dir)` after the
// promoted write lands. This test asserts that contract (the exact call the
// promotion path makes) updates the SHARED record without touching the source.
test("shared-namespace promotion updates the shared namespace lastWriteAt in the catalog", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // Resolve shared storage exactly as the promotion path does (router-routed),
    // so sharedStorage.dir matches the dir the orchestrator passes to the catalog.
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // Before: no shared catalog write recorded yet.
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(!before?.lastWriteAt, "shared lastWriteAt should be unset before promotion");

    // Fire the exact catalog touch the promotion path now performs after a
    // successful sharedStorage.writeMemory. markCatalogWrite is private; access
    // via the `as any` orchestrator handle, mirroring the routing tests.
    orchestrator.markCatalogWrite(config.sharedNamespace, sharedStorage.dir);

    // markCatalogWrite is fire-and-forget; let the serialized append settle.
    await orchestrator.namespaceCatalog.markRead("shared"); // serializes after the write

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(after, "shared record must exist after promotion touch");
    assert.equal(after?.kind, "shared");
    assert.ok(
      after?.lastWriteAt,
      "shared promotion must update the shared namespace's lastWriteAt",
    );
    assert.equal(
      after?.storageDir,
      sharedStorage.dir,
      "shared catalog storageDir must match the router-resolved shared dir",
    );

    // No double-count of the source: the default/source namespace must not have
    // received a write touch from the shared promotion.
    const sourceRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("default");
    assert.ok(
      !sourceRecord?.lastWriteAt,
      "shared promotion must not record a write on the source namespace",
    );

    // The shared record is surfaced by a writtenSince filter (the consumer the
    // bug report cited) using a lower bound just before the touch.
    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === "shared"),
      "writtenSince must now surface the shared namespace after promotion",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Integration guard for Issue B: drive the actual promotion path via
// `persistExtraction` (auto-promote enabled, source namespace != shared) and
// assert the SHARED catalog record gains lastWriteAt as a side effect of the
// promoted write. This fails on the round-1 code (no shared markCatalogWrite in
// promoteMemoryToShared) and passes after the fix.
test("persistExtraction shared promotion records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-integ-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      autoPromoteToSharedEnabled: true,
      autoPromoteToSharedCategories: ["fact"],
      autoPromoteMinConfidenceTier: "implied",
      // Keep the write path simple/offline: no linking, no chunking-by-size, no
      // semantic dedup that would need an embedding backend.
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    // QMD unavailable so the write path stays offline and deterministic.
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // A single high-confidence fact in a promotable category.
    const result = {
      facts: [
        {
          content: "The team standup is at 9am every weekday.",
          category: "fact",
          confidence: 0.95,
          tags: ["schedule"],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    };

    await orchestrator.persistExtraction(result, sourceStorage, null, {
      sessionKey: "s1",
      principal: "default",
    });

    // Let any fire-and-forget catalog appends settle by serializing a read.
    await orchestrator.namespaceCatalog.markRead("shared");

    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(sharedRecord, "shared record must exist after a promoted write");
    assert.ok(
      sharedRecord?.lastWriteAt,
      "the shared promotion must record a write touch on the shared namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 3, Issue #3 (codex P2): when the planner selects no_recall, retrieval
// is skipped — so the recall path must NOT mark every readable namespace as
// read. A trivial prompt ("ok") classifies as no_recall; assert the catalog
// records no lastReadAt for the recalled namespaces. Fails on the round-2 code
// (read touch fired before the no_recall early return), passes after the gate.
test("no_recall recall does not record catalog read touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-no-recall-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // A trivial prompt the planner classifies as no_recall (mirrors the existing
    // recall-no-recall-short-circuit tests).
    const out = await orchestrator.recallInternal("ok", "user:test:no-recall-catalog");
    assert.equal(out, "", "no_recall must produce no recall context");

    // Allow any (incorrect) fire-and-forget read touch to settle, then serialize
    // a maintenance touch on the catalog write chain to flush pending appends
    // before asserting NONE was recorded for the readable namespaces.
    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.namespaceCatalog.markMaintenance("default", "probe");
    const records = await orchestrator.namespaceCatalog.listNamespaces();
    for (const r of records) {
      assert.ok(
        !r.lastReadAt,
        `no_recall must not record a read touch (namespace ${r.namespace} has lastReadAt)`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #5 (codex P2): even when recallMode is not no_recall, a zero
// effective result limit (topK: 0, disabled/zero `memories` section) means no
// namespace is actually read — the QMD path returns before searching when
// recallResultLimit <= 0. The catalog must not record read touches in that case.
test("zero recall result limit (topK:0) records no catalog read touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-zero-limit-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    // Force a non-no_recall mode but a zero result limit via topK: 0.
    await orchestrator.recallInternal(
      "What is the team standup schedule and who attends it?",
      "user:test:zero-limit",
      { mode: "minimal", topK: 0 },
    );

    // Drain any fire-and-forget tails, then serialize a maintenance touch on the
    // catalog write chain so any (incorrectly) enqueued read append is flushed
    // before we assert its absence.
    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.namespaceCatalog.markMaintenance("default", "probe");
    const records = await orchestrator.namespaceCatalog.listNamespaces();
    for (const r of records) {
      assert.ok(
        !r.lastReadAt,
        `zero result limit must not record a read touch (namespace ${r.namespace} has lastReadAt)`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NBsFz): `namespaceFromStorageDir` decodes ONLY a genuine
// tokenized dir — one whose decoded identity round-trips back to the exact dir
// name via `namespaceIdentityToken`. A `ns-...`-shaped dir name that does NOT
// round-trip is treated as a literal raw name and returned verbatim, so a
// token-shaped raw namespace name is never silently rewritten into a different
// identity by the catalog write touch. (Regression guard for the round-trip
// containment; the inherent same-bytes ambiguity of a raw name that is ALSO a
// canonical token is resolved at the call site by passing the known namespace.)
test("namespaceFromStorageDir preserves a token-shaped literal raw namespace name", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-from-dir-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const orchestrator = new Orchestrator(config) as any;

    // Helper mirroring `namespaceIdentityToken`: ns-<lowercase hex of UTF-8>.
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;

    // A legacy raw-name dir whose name is `ns-`-prefixed and hex-shaped but is
    // NOT a valid canonical token (odd-length hex does not decode). Pre-fix this
    // mangled the name via `namespaceIdentityFromToken(...) ?? name`; the
    // round-trip guard now preserves it verbatim.
    const literal = "ns-deadbee"; // odd-length hex after the prefix → not decodable
    const rawDir = path.join(memoryDir, "namespaces", literal);
    assert.equal(
      orchestrator.namespaceFromStorageDir(rawDir),
      literal,
      "a token-shaped but non-canonical raw name must be preserved verbatim, not mangled",
    );

    // Control: a GENUINE tokenized dir still decodes back to its identity.
    const realNs = "team-pi-project-origin-abc123";
    const tokenDir = path.join(memoryDir, "namespaces", tokenize(realNs));
    assert.equal(
      orchestrator.namespaceFromStorageDir(tokenDir),
      realNs,
      "a genuine tokenized dir must still decode to its namespace identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
