/**
 * Recall navigation unit tests (issue #1956).
 *
 * Window authority (served / not-served / expired-by-window), disclosure
 * deepening, traverse relation semantics, budget clamping + disclosure
 * spend, entity neighbors — over a real RecallHandleHistoryStore and real
 * StorageManager instances so the storage-facing seams behave as shipped.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessInputError } from "./access-errors.js";
import { renderHandle } from "./recall-handles.js";
import { runRecallNavigation, type RecallNavigationDeps } from "./recall-navigation.js";
import { RECALL_NAVIGATION_CONFIG_DEFAULTS } from "./recall-navigation-config.js";
import { RecallHandleHistoryStore } from "./recall-state.js";
import { StorageManager } from "./storage.js";

const SESSION = "project/nav-test/1";

interface Fixture {
  history: RecallHandleHistoryStore;
  storages: Record<string, StorageManager>;
  depsFor: (overrides?: Partial<RecallNavigationDeps>) => RecallNavigationDeps;
  cleanup: () => Promise<void>;
}

async function fixture(options: { windowSnapshots?: number; recallBudgetChars?: number } = {}): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "remnic-nav-unit-"));
  const history = new RecallHandleHistoryStore(base, { maxDepth: 10 });
  await history.load();
  const storages: Record<string, StorageManager> = {
    default: makeStorage(path.join(base, "default")),
    ns_alice: makeStorage(path.join(base, "namespaces", "ns_alice")),
    ns_bob: makeStorage(path.join(base, "namespaces", "ns_bob")),
  };
  const config = { ...RECALL_NAVIGATION_CONFIG_DEFAULTS, ...options };
  const depsFor = (overrides: Partial<RecallNavigationDeps> = {}): RecallNavigationDeps => ({
    config,
    recallBudgetChars: options.recallBudgetChars ?? 100000,
    recentServedIds: (sessionKey, depth) => history.recent(sessionKey, depth),
    resolveReadableNamespace: (namespace) => namespace ?? "default",
    getStorage: async (namespace) => storages[namespace] ?? storages.default!,
    ...overrides,
  });
  return {
    history,
    storages,
    depsFor,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(base, { recursive: true, force: true });
    },
  };
}

function makeStorage(dir: string): StorageManager {
  const storage = new StorageManager(dir);
  void storage.ensureDirectories();
  return storage;
}

async function writeMemory(
  storage: StorageManager,
  content: string,
  options: { entityRef?: string; links?: Array<{ targetId: string; linkType: "follows" | "references" | "contradicts" | "supports" | "related"; strength: number }> } = {},
): Promise<string> {
  const result = await storage.writeMemory("fact", content, {
    ...(options.entityRef !== undefined ? { entityRef: options.entityRef } : {}),
    ...(options.links !== undefined ? { links: options.links } : {}),
  });
  return result.id;
}

test("expand serves served ids at deeper disclosure and rejects unserved/expired ids", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "The API rate limit is 1000 requests per minute.");
    await f.history.record(SESSION, [id]);

    const raw = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(raw.ok);
    assert.equal(raw.items.length, 1);
    assert.equal(raw.items[0]?.disclosure, "raw");
    assert.equal(raw.items[0]?.content, "The API rate limit is 1000 requests per minute.");
    assert.ok(raw.items[0]!.estimatedTokens > 0, "raw disclosure must report estimated tokens");
    assert.equal(raw.disclosureSpend.raw.count, 1);

    const section = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "section",
    });
    assert.ok(section.ok);
    assert.equal(section.items[0]?.disclosure, "section");

    // chunk is not deeper than what recall already served → typed refusal.
    const chunk = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "chunk",
    });
    assert.ok(!chunk.ok);
    assert.equal(chunk.error, "not_deeper");
    assert.match(chunk.message, /deeper/);

    // Never-served id → not_served naming the constraint.
    const stranger = await writeMemory(storage, "Never recalled by this session.");
    const unserved = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: stranger,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(!unserved.ok);
    assert.equal(unserved.error, "not_served");
    assert.match(unserved.message, /windowSnapshots|recall snapshots/);

    // Window expiry: with windowSnapshots=3, four newer recalls evict the id.
    for (let i = 0; i < 4; i += 1) {
      const newer = await writeMemory(storage, `displacing recall ${i}`);
      await f.history.record(SESSION, [newer]);
    }
    const expired = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(!expired.ok);
    assert.equal(expired.error, "not_served");
  } finally {
    await f.cleanup();
  }
});

test("traverse filters by relation, clamps limits, and skips foreign-namespace targets", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const supported = await writeMemory(storage, "Supporting evidence memory.");
    const contradicted = await writeMemory(storage, "Contradicting evidence memory.");
    const elaborated = await writeMemory(storage, "Elaborating evidence memory.");
    const source = await writeMemory(storage, "Source decision memory.", {
      links: [
        { targetId: supported, linkType: "supports", strength: 0.9 },
        { targetId: contradicted, linkType: "contradicts", strength: 0.8 },
        { targetId: elaborated, linkType: "related", strength: 0.7 },
      ],
    });
    // A link whose target lives only in another namespace must resolve to
    // nothing here: neighbors come from the SAME resolved storage.
    const foreign = await writeMemory(f.storages.ns_bob!, "Bob-namespace memory.");
    const withForeign = await writeMemory(storage, "Second source memory.", {
      links: [{ targetId: foreign, linkType: "references", strength: 0.5 }],
    });
    await f.history.record(SESSION, [source, withForeign]);

    const all = await runRecallNavigation(f.depsFor(), { action: "traverse", memoryId: source, sessionKey: SESSION });
    assert.ok(all.ok);
    assert.equal(all.items.length, 3);
    assert.deepEqual(
      all.items.map((item) => item.linkType).sort(),
      ["contradicts", "related", "supports"],
    );
    for (const item of all.items) {
      assert.equal(item.disclosure, "chunk");
      assert.equal(item.content, undefined, "neighbors stay chunk-level (preview only)");
    }

    const contradictsOnly = await runRecallNavigation(f.depsFor(), {
      action: "traverse",
      memoryId: source,
      sessionKey: SESSION,
      relation: "contradicts",
    });
    assert.ok(contradictsOnly.ok);
    assert.equal(contradictsOnly.items.length, 1);
    assert.equal(contradictsOnly.items[0]?.memoryId, contradicted);
    assert.equal(contradictsOnly.items[0]?.linkType, "contradicts");

    const limited = await runRecallNavigation(f.depsFor(), {
      action: "traverse",
      memoryId: source,
      sessionKey: SESSION,
      limit: 1,
    });
    assert.ok(limited.ok);
    assert.equal(limited.items.length, 1);

    const badRelation = await runRecallNavigation(f.depsFor(), {
      action: "traverse",
      memoryId: source,
      sessionKey: SESSION,
      relation: "sides_with",
    });
    assert.ok(!badRelation.ok);
    assert.equal(badRelation.error, "unknown_relation");
    assert.match(badRelation.message, /supports/);

    // Cross-namespace link: the target is invisible in the resolved
    // namespace, so the traverse returns zero neighbors — no leak, no error.
    const foreignTraverse = await runRecallNavigation(f.depsFor(), {
      action: "traverse",
      memoryId: withForeign,
      sessionKey: SESSION,
    });
    assert.ok(foreignTraverse.ok);
    assert.equal(foreignTraverse.items.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("budget caps expansion output and reports disclosure spend", async () => {
  const f = await fixture({ recallBudgetChars: 800 });
  try {
    const storage = f.storages.default!;
    const long = "x".repeat(500);
    const id = await writeMemory(storage, long);
    await f.history.record(SESSION, [id]);

    const result = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(result.ok);
    assert.equal(result.budget.chars, 800);
    const { rendered: _rendered, ...structured } = result;
    assert.equal(result.budget.used, JSON.stringify(structured).length);
    assert.ok(result.budget.used <= 800, `used ${result.budget.used} must respect the cap`);
    assert.ok(result.truncated);
    assert.equal(result.disclosureSpend.raw.count, 1);
    assert.match(result.rendered, /- budget: \d+\/800 chars \(truncated\)/);
    assert.match(result.rendered, /- disclosure spend: chunk=\d+t, section=\d+t, raw=\d+t/);
  } finally {
    await f.cleanup();
  }
});

test("entity neighbors share entityRef, exclude the source, and honor the limit", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const a = await writeMemory(storage, "Alice fact one.", { entityRef: "person-alice" });
    const b = await writeMemory(storage, "Alice fact two.", { entityRef: "person-alice" });
    const c = await writeMemory(storage, "Alice fact three.", { entityRef: "person-alice" });
    await writeMemory(storage, "Unrelated fact.", { entityRef: "project-unrelated" });
    await f.history.record(SESSION, [a]);

    const neighbors = await runRecallNavigation(f.depsFor(), {
      action: "entity_neighbors",
      memoryId: a,
      sessionKey: SESSION,
      limit: 2,
    });
    assert.ok(neighbors.ok);
    assert.equal(neighbors.items.length, 2);
    const ids = neighbors.items.map((item) => item.memoryId);
    assert.ok(!ids.includes(a), "source memory is not its own neighbor");
    assert.ok(ids.includes(b) || ids.includes(c));

    const entityless = await writeMemory(storage, "No entity ref.");
    await f.history.record(SESSION, [entityless]);
    const empty = await runRecallNavigation(f.depsFor(), {
      action: "entity_neighbors",
      memoryId: entityless,
      sessionKey: SESSION,
    });
    assert.ok(empty.ok);
    assert.equal(empty.items.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("disabled config and missing sessionKey are explicit refusals", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "Served memory.");
    await f.history.record(SESSION, [id]);

    const disabled = await runRecallNavigation(f.depsFor({ config: { ...RECALL_NAVIGATION_CONFIG_DEFAULTS, enabled: false } }), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(!disabled.ok);
    assert.equal(disabled.error, "disabled");

    await assert.rejects(
      runRecallNavigation(f.depsFor(), { action: "expand", memoryId: id, sessionKey: "  ", disclosure: "raw" }),
      EngramAccessInputError,
    );
    await assert.rejects(
      runRecallNavigation(f.depsFor(), {
        action: "traverse",
        memoryId: id,
        sessionKey: SESSION,
        limit: 0,
      }),
      /positive integer/,
    );
  } finally {
    await f.cleanup();
  }
});

test("expand resolves a documented [m:xxxx] handle before the authority check", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "Handle-cited memory body.");
    await f.history.record(SESSION, [id]);
    const viaHandle = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: renderHandle(id),
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(viaHandle.ok);
    assert.equal(viaHandle.memoryId, id);
    assert.match(viaHandle.items[0]?.content ?? "", /Handle-cited/);

    const unknown = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: "[m:dead]",
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(!unknown.ok);
    assert.equal(unknown.error, "not_served");
  } finally {
    await f.cleanup();
  }
});

test("traverse truncated is true when the relation set exceeds the limit", async () => {
  const f = await fixture();
  try {
    const storage = f.storages.default!;
    const a = await writeMemory(storage, "Neighbor A.");
    const b = await writeMemory(storage, "Neighbor B.");
    const c = await writeMemory(storage, "Neighbor C.");
    const source = await writeMemory(storage, "Source with three follows.", {
      links: [
        { targetId: a, linkType: "follows", strength: 0.9 },
        { targetId: b, linkType: "follows", strength: 0.8 },
        { targetId: c, linkType: "follows", strength: 0.7 },
      ],
    });
    await f.history.record(SESSION, [source]);
    const limited = await runRecallNavigation(f.depsFor(), {
      action: "traverse",
      memoryId: source,
      sessionKey: SESSION,
      limit: 1,
    });
    assert.ok(limited.ok);
    assert.equal(limited.items.length, 1);
    assert.equal(limited.truncated, true, "limit truncation must survive a budget that fits the kept neighbor");
  } finally {
    await f.cleanup();
  }
});

test("budget used is the serialized payload size including metadata, not preview+content twice", async () => {
  const f = await fixture({ recallBudgetChars: 1800 });
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "Serialized budget body.");
    await f.history.record(SESSION, [id]);
    const result = await runRecallNavigation(f.depsFor(), {
      action: "expand",
      memoryId: id,
      sessionKey: SESSION,
      disclosure: "raw",
    });
    assert.ok(result.ok);
    const { rendered: _rendered, ...structured } = result;
    const serialized = JSON.stringify(structured);
    assert.equal(result.budget.used, serialized.length);
    assert.ok(result.budget.used <= result.budget.chars);
    const bodyChars = (result.items[0]?.preview.length ?? 0) + (result.items[0]?.content?.length ?? 0);
    assert.ok(result.budget.used > bodyChars, "metadata must count toward used");
  } finally {
    await f.cleanup();
  }
});
