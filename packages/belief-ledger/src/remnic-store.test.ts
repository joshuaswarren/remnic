import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { StorageManager } from "@remnic/core";
import { createVersion, listVersions } from "@remnic/core/page-versioning";

import { RemnicLedgerStore } from "./remnic-store.js";
// Imported from the package barrel (./index.js) — proves the error is re-exported
// for published consumers that catch it via instanceof (#1645 review).
import { RemnicLedgerTombstoneBlockedError } from "./index.js";
import { normalizeClaimDraft } from "./schema.js";
import { withTempDir } from "./testing/tmp-dir.js";

async function withStore<T>(fn: (store: RemnicLedgerStore, storage: StorageManager) => Promise<T>): Promise<T> {
  return await withTempDir("store", async (dir) => {
    const storage = new StorageManager(dir);
    const store = new RemnicLedgerStore(storage, {
      now: () => new Date("2026-06-03T12:00:00Z"),
    });
    return await fn(store, storage);
  });
}

describe("RemnicLedgerStore", () => {
  it("persists claims as Remnic memories with custom metadata and entity links", async () => {
    await withStore(async (store, storage) => {
      const input = normalizeClaimDraft(
        {
          statement: "Local-first memory tools will beat cloud-only memory tools.",
          stance: "for",
          confidence: 0.8,
          scope: {
            entities: ["Memory Tools"],
            domain: "ai memory",
          },
        },
        { now: "2026-06-03T12:00:00Z" }
      );

      const claim = await store.createClaim(input);
      const reread = await store.getClaim(claim.id);
      assert.ok(reread);
      assert.equal(reread.statement, input.statement);
      assert.equal(reread.scope.domain, "ai memory");
      assert.equal(reread.sourceMemory?.frontmatter.structuredAttributes?.["ledger.kind"], "claim");
      assert.equal(reread.sourceMemory?.frontmatter.structuredAttributes?.["ledger.confidence"], "0.8");

      const entities = await storage.readAllEntityFiles();
      const entity = entities.find((candidate) => candidate.name === "Memory Tools");
      assert.ok(entity);
      assert.equal(entity.timeline.length, 0);
      const beliefSection = entity.structuredSections?.find((section) => section.key === "belief_ledger");
      assert.ok(beliefSection?.facts.some((fact) => fact.includes("status=active") && fact.includes(input.statement)));
    });
  });

  it("retains bounded source text when sealing long claim provenance", async () => {
    await withStore(async (store) => {
      const input = normalizeClaimDraft(
        {
          statement: "Long claim provenance must remain recoverable.",
          stance: "for",
          confidence: 0.8,
          scope: { entities: ["Envelope"], domain: "storage" },
        },
        { now: "2026-06-03T12:00:00Z", sourceText: "source ".repeat(900) },
      );

      const claim = await store.createClaim(input);

      assert.ok(claim.sourceText);
      assert.equal(claim.sourceText.length, 1_024);
      assert.match(claim.sourceText, /\[truncated\]$/);
    });
  });

  it("preserves multiline claim statements when reading through Remnic storage", async () => {
    await withStore(async (store) => {
      const input = normalizeClaimDraft(
        {
          statement: "Local-first memory tools will win.\nCloud-only tools will remain useful for teams.",
          stance: "for",
          confidence: 0.8,
          scope: {
            entities: ["Memory Tools"],
            domain: "ai memory",
          },
        },
        { now: "2026-06-03T12:00:00Z" }
      );

      const claim = await store.createClaim(input);

      assert.equal(claim.statement, input.statement);
    });
  });

  it("keeps created claims successful when entity link writes fail", async () => {
    await withStore(async (store, storage) => {
      storage.writeEntity = async () => {
        throw new Error("entity index unavailable");
      };
      const input = normalizeClaimDraft(
        {
          statement: "Entity link failures should not orphan caller-visible claims.",
          stance: "for",
          confidence: 0.8,
          scope: {
            entities: ["Entity Index"],
            domain: "storage",
          },
        },
        { now: "2026-06-03T12:00:00Z" }
      );

      const claim = await store.createClaim(input);

      assert.equal(claim.statement, input.statement);
      assert.equal((await store.getClaim(claim.id))?.statement, input.statement);
    });
  });

  it("preserves historical ledger timestamps when reading claims back", async () => {
    await withStore(async (store) => {
      const input = normalizeClaimDraft(
        {
          statement: "Backfilled predictions should keep their original claim time.",
          kind: "prediction",
          stance: "for",
          confidence: 0.65,
          deadline: "2020-02-01T00:00:00Z",
          scope: { entities: ["Backfill"], domain: "timeline" },
        },
        { now: "2020-01-01T00:00:00Z" }
      );

      const claim = await store.createClaim(input);
      const reread = await store.getClaim(claim.id);

      assert.equal(claim.createdAt, "2020-01-01T00:00:00.000Z");
      assert.equal(claim.updatedAt, "2020-01-01T00:00:00.000Z");
      assert.equal(reread?.createdAt, "2020-01-01T00:00:00.000Z");
      assert.equal(reread?.updatedAt, "2020-01-01T00:00:00.000Z");
    });
  });

  it("skips corrupt ledger memories when listing claims", async () => {
    await withStore(async (store, storage) => {
      const valid = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Valid claims should still be listed.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Valid"], domain: "quality" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );

      await storage.writeMemory("fact", "# Belief Ledger Claim\n\nBroken claim.\n\nKind: claim\nStatus: active\n", {
        actor: "belief-ledger-test",
        source: "belief-ledger",
        confidence: 0.5,
        tags: ["belief-ledger"],
        structuredAttributes: {
          "ledger.schemaVersion": "1",
          "ledger.kind": "claim",
          "ledger.stance": "neutral",
          "ledger.confidence": "2",
          "ledger.entities": "[]",
          "ledger.status": "active",
          "ledger.createdAt": "not-a-date",
          "ledger.updatedAt": "2026-06-03T12:00:00.000Z",
          "ledger.parentIds": "[]",
        },
      });

      const claims = await store.listClaims();

      assert.deepEqual(
        claims.map((claim) => claim.id),
        [valid.id]
      );
    });
  });

  it("lists active ledger claims after Remnic migrates them to cold storage", async () => {
    await withStore(async (store, storage) => {
      const claim = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Cold-tier beliefs should remain available to the ledger.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Cold Tier"], domain: "storage" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );
      const memory = await storage.getMemoryById(claim.id);
      assert.ok(memory);

      await storage.migrateMemoryToTier(memory, "cold");

      const claims = await store.listClaims({ statuses: ["active"] });

      assert.ok(claims.some((listed) => listed.id === claim.id));
    });
  });

  it("reads and updates individual ledger claims after Remnic migrates them to cold storage", async () => {
    await withStore(async (store, storage) => {
      const claim = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Cold-tier predictions should remain editable.",
            kind: "prediction",
            stance: "for",
            confidence: 0.7,
            deadline: "2026-06-01T00:00:00Z",
            scope: { entities: ["Cold Tier"], domain: "storage" },
          },
          { now: "2026-05-01T12:00:00Z" }
        )
      );
      const memory = await storage.getMemoryById(claim.id);
      assert.ok(memory);

      await storage.migrateMemoryToTier(memory, "cold");

      assert.equal((await store.getClaim(claim.id))?.statement, claim.statement);
      const resolved = await store.updateClaim(claim.id, {
        status: "resolved",
        resolution: {
          verdict: "true",
          actualConfidence: 1,
          resolvedAt: "2026-06-03T12:00:00.000Z",
          brierScore: 0.09,
        },
      });

      assert.equal(resolved.status, "resolved");
      assert.equal((await store.getClaim(claim.id))?.resolution?.verdict, "true");
      const cold = (await storage.readAllColdMemories()).find((candidate) => candidate.frontmatter.id === claim.id);
      assert.equal(cold?.frontmatter.status, "archived");
      assert.equal(cold?.frontmatter.structuredAttributes?.["ledger.status"], "resolved");
    });
  });

  it("persists edited claim bodies when updating claims", async () => {
    await withStore(async (store, storage) => {
      const claim = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Original belief body.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Body"], domain: "storage" },
          },
          { now: "2026-06-01T12:00:00Z" }
        )
      );

      const beforeMemory = await storage.getMemoryById(claim.id);
      assert.ok(beforeMemory);
      assert.equal(await storage.hasFactContentHash(beforeMemory.content), true);

      const updated = await store.updateClaim(claim.id, {
        statement: "Edited belief body.",
      });

      assert.equal(updated.statement, "Edited belief body.");
      assert.equal((await store.getClaim(claim.id))?.statement, "Edited belief body.");
      const memory = await storage.getMemoryById(claim.id);
      assert.match(memory?.content ?? "", /Edited belief body/);
      assert.doesNotMatch(memory?.content ?? "", /Original belief body/);
      assert.notEqual(memory?.frontmatter.contentHash, beforeMemory.frontmatter.contentHash);
      assert.equal(await storage.hasFactContentHash(beforeMemory.content), false);
      assert.equal(await storage.hasFactContentHash(memory?.content ?? ""), true);
    });
  });

  it("keeps Remnic frontmatter and ledger metadata in sync during supersession", async () => {
    await withStore(async (store) => {
      const first = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Cloud-only memory tools will win.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
          { now: "2026-06-01T12:00:00Z" }
        )
      );
      const second = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "Local-first memory tools will win.",
            stance: "for",
            confidence: 0.8,
            scope: { entities: ["Memory Tools"], domain: "ai memory" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );

      assert.equal(await store.supersedeClaim(first.id, second.id, "newer belief"), true);

      const prior = await store.getClaim(first.id);
      const current = await store.getClaim(second.id);
      assert.equal(prior?.status, "superseded");
      assert.equal(prior?.supersededBy, second.id);
      assert.equal(current?.supersedes, first.id);
      assert.ok(current?.parentIds.includes(first.id));
    });
  });

  it("does not mutate a prior claim when the replacement claim is missing", async () => {
    await withStore(async (store, storage) => {
      const prior = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "A replacement should exist before supersession.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Supersession"], domain: "quality" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );

      assert.equal(await store.supersedeClaim(prior.id, "missing-claim", "replacement missing"), false);

      const reread = await store.getClaim(prior.id);
      const memory = await storage.getMemoryById(prior.id);
      assert.equal(reread?.status, "active");
      assert.equal(reread?.supersededBy, undefined);
      assert.equal(memory?.frontmatter.status, "active");
    });
  });

  it("rolls back replacement lineage when prior supersession update fails", async () => {
    await withStore(async (store, storage) => {
      const first = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The first supersession write can fail.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Supersession"], domain: "quality" },
          },
          { now: "2026-06-01T12:00:00Z" }
        )
      );
      const second = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The replacement should be rolled back on failure.",
            stance: "for",
            confidence: 0.8,
            scope: { entities: ["Supersession"], domain: "quality" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );
      const writeMemoryFrontmatter = storage.writeMemoryFrontmatter.bind(storage);
      storage.writeMemoryFrontmatter = async (memory, patch, lifecycle) => {
        if (patch.supersededBy === second.id) {
          throw new Error("prior write failed");
        }
        return writeMemoryFrontmatter(memory, patch, lifecycle);
      };

      await assert.rejects(() => store.supersedeClaim(first.id, second.id, "newer belief"), /prior write failed/);

      const prior = await store.getClaim(first.id);
      const replacement = await store.getClaim(second.id);
      assert.equal(prior?.status, "active");
      assert.equal(prior?.supersededBy, undefined);
      assert.equal(replacement?.supersedes, undefined);
      assert.equal(replacement?.parentIds.includes(first.id), false);
    });
  });

  it("surfaces rollback failure when replacement restore cannot be persisted", async () => {
    await withStore(async (store, storage) => {
      const first = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The prior supersession write can fail.",
            stance: "for",
            confidence: 0.7,
            scope: { entities: ["Supersession"], domain: "quality" },
          },
          { now: "2026-06-01T12:00:00Z" }
        )
      );
      const second = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The replacement restore can fail too.",
            stance: "for",
            confidence: 0.8,
            scope: { entities: ["Supersession"], domain: "quality" },
          },
          { now: "2026-06-03T12:00:00Z" }
        )
      );
      const writeMemoryFrontmatter = storage.writeMemoryFrontmatter.bind(storage);
      let restoreAttempted = false;
      storage.writeMemoryFrontmatter = async (memory, patch, lifecycle) => {
        if (patch.supersededBy === second.id) {
          throw new Error("prior write failed");
        }
        if (memory.frontmatter.id === second.id && patch.supersedes === undefined) {
          restoreAttempted = true;
          return false;
        }
        return writeMemoryFrontmatter(memory, patch, lifecycle);
      };

      await assert.rejects(
        () => store.supersedeClaim(first.id, second.id, "newer belief"),
        /rollback failed.*prior write failed/
      );

      assert.equal(restoreAttempted, true);
      const replacement = await store.getClaim(second.id);
      assert.equal(replacement?.supersedes, first.id);
    });
  });

  it("archives resolved and ignored claims in Remnic frontmatter", async () => {
    await withStore(async (store, storage) => {
      const first = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The preview will ship by June.",
            kind: "prediction",
            stance: "for",
            confidence: 0.7,
            deadline: "2026-06-01T00:00:00Z",
            scope: { entities: ["Preview"], domain: "shipping" },
          },
          { now: "2026-05-01T12:00:00Z" }
        )
      );
      const second = await store.createClaim(
        normalizeClaimDraft(
          {
            statement: "The beta release is blocked.",
            stance: "for",
            confidence: 0.6,
            scope: { entities: ["Beta"], domain: "shipping" },
          },
          { now: "2026-05-01T12:00:00Z" }
        )
      );

      await store.updateClaim(first.id, {
        status: "resolved",
        resolution: {
          verdict: "false",
          actualConfidence: 0,
          resolvedAt: "2026-06-03T12:00:00.000Z",
          brierScore: 0.49,
        },
      });
      await store.updateClaim(second.id, {
        status: "ignored",
        ignoredAt: "2026-06-03T12:00:00.000Z",
      });

      const resolved = await storage.getMemoryById(first.id);
      const ignored = await storage.getMemoryById(second.id);
      assert.equal(resolved?.frontmatter.status, "archived");
      assert.equal(ignored?.frontmatter.status, "archived");
      assert.equal((await store.getClaim(first.id))?.status, "resolved");
      assert.equal((await store.getClaim(second.id))?.status, "ignored");
    });
  });

  it("can reach public core page-versioning from an external package", async () => {
    await withTempDir("versioning", async (dir) => {
      const pagePath = path.join(dir, "facts", "belief-ledger.md");
      await mkdir(path.dirname(pagePath), { recursive: true });
      await writeFile(pagePath, "first version\n", "utf-8");

      const version = await createVersion(
        pagePath,
        "first version\n",
        "manual",
        { enabled: true, maxVersionsPerPage: 5, sidecarDir: ".versions" },
        undefined,
        "belief ledger external consumer smoke test",
        dir,
      );
      const versions = await listVersions(
        pagePath,
        { enabled: true, maxVersionsPerPage: 5, sidecarDir: ".versions" },
        dir,
      );

      assert.equal(version.versionId, "1");
      assert.equal(versions.versions.length, 1);
      assert.equal(versions.versions[0]?.trigger, "manual");
    });
  });


  it("#1645: createClaim throws a distinct tombstone_blocked error (not readback failure)", async () => {
    await withTempDir("tombstone", async (dir) => {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      // Wire the tombstone invariant exactly as the orchestrator does — without
      // this, appendTombstone is a no-op and writeMemory never checks tombstones.
      storage.setTombstonesConfig({
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        namespace: "default",
      });
      const store = new RemnicLedgerStore(storage, {
        now: () => new Date("2026-06-03T12:00:00Z"),
      });
      const input = normalizeClaimDraft(
        {
          statement: "The legacy deploy endpoint is https://legacy.example.invalid/v2",
          stance: "for",
          confidence: 0.9,
          scope: { entities: ["Deploy"] },
        },
        { now: "2026-06-03T12:00:00Z" },
      );
      // Tombstone the exact body writeMemory receives — a blocked claim lands
      // pending_review, which getClaim hides (HIDDEN_REMNIC_STATUSES). Without
      // the pre-readback guard, createClaim throws a misleading "could not be
      // read back" error that looks transient → callers retry → duplicate rows.
      // writeMemory enriches the content with a structured-attributes suffix
      // before hashing for the tombstone chokepoint (storage.ts:3728-3749), so
      // the tombstone rawContent must match the ENRICHED body, not the raw body.
      const { serializeClaimBody, claimToStructuredAttributes } = await import("./schema.js");
      const { normalizeAttributePairs } = await import("@remnic/core/storage");
      const pendingClaim = { ...input, id: "pending", memoryId: "pending" };
      const enrichedBody = `${serializeClaimBody(pendingClaim)}
[Attributes: ${normalizeAttributePairs(claimToStructuredAttributes(pendingClaim))}]`;
      await storage.appendTombstone({
        reason: "retraction",
        createdBy: "user_correction",
        sourceMemoryId: "claim-old",
        rawContent: enrichedBody,
      });

      await assert.rejects(
        () => store.createClaim(input),
        (err: Error & { code?: string }) =>
          err.code === "tombstone_blocked" &&
          err.message.includes("tombstone-blocked"),
        "createClaim must throw a distinct tombstone_blocked error before the readback",
      );
    });
  });

  it("#1645: the tombstone_blocked error is instanceof-catchable from the package root (review)", async () => {
    // Published consumers import from @remnic/belief-ledger (the package barrel);
    // the error class must be re-exported so they can catch it via instanceof.
    await withTempDir("tombstone-catch", async (dir) => {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      storage.setTombstonesConfig({
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        namespace: "default",
      });
      const store = new RemnicLedgerStore(storage, {
        now: () => new Date("2026-06-03T12:00:00Z"),
      });
      const input = normalizeClaimDraft(
        {
          statement: "The legacy deploy endpoint is https://legacy.example.invalid/v2",
          stance: "for",
          confidence: 0.9,
          scope: { entities: ["Deploy"] },
        },
        { now: "2026-06-03T12:00:00Z" },
      );
      const { serializeClaimBody, claimToStructuredAttributes } = await import("./schema.js");
      const { normalizeAttributePairs } = await import("@remnic/core/storage");
      const pendingClaim = { ...input, id: "pending", memoryId: "pending" };
      const enrichedBody = `${serializeClaimBody(pendingClaim)}
[Attributes: ${normalizeAttributePairs(claimToStructuredAttributes(pendingClaim))}]`;
      await storage.appendTombstone({
        reason: "retraction",
        createdBy: "user_correction",
        sourceMemoryId: "claim-old",
        rawContent: enrichedBody,
      });

      let caught: unknown;
      try {
        await store.createClaim(input);
      } catch (err) {
        caught = err;
      }
      assert.ok(
        caught instanceof RemnicLedgerTombstoneBlockedError,
        "a tombstone-blocked createClaim must be instanceof the package-root RemnicLedgerTombstoneBlockedError",
      );
      assert.equal((caught as RemnicLedgerTombstoneBlockedError).code, "tombstone_blocked");
    });
  });

});
