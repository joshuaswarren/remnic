import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeContentHash as computeHash,
  computeLegacyContentHash,
  normalizeContent,
  normalizeLegacyContent,
} from "../content-hash.js";
import {
  TombstoneStore,
  parseTombstoneLine,
  type TombstoneFileIo,
} from "./tombstones.js";

function makeIo(): TombstoneFileIo {
  return {
    read: (p) => readFile(p, "utf8"),
    append: async (p, c) => {
      await mkdir(path.dirname(p), { recursive: true });
      await appendFile(p, c, "utf8");
    },
    write: async (p, c) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, c, "utf8");
    },
  };
}

async function makeStore(
  namespace: string,
  opts: { enabled?: boolean; semanticMatch?: boolean } = {},
): Promise<{ store: TombstoneStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "tomb-"));
  const filePath = path.join(dir, "state", "tombstones.jsonl");
  const store = new TombstoneStore(
    filePath,
    namespace,
    {
      enabled: opts.enabled ?? true,
      semanticMatch: opts.semanticMatch ?? false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
    },
    makeIo(),
  );
  return { store, dir };
}

describe("TombstoneStore — append/lookup round-trip", () => {
  it("blocks an exact contentHash match", async () => {
    const env = await makeStore("default");
    const id = await env.store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-1",
      rawContent: "The database is MySQL.",
    });
    assert.match(id, /^tomb-/);
    await env.store.load();
    const match = env.store.lookup({
      namespace: "default",
      contentHash: computeHash("The database is MySQL."),
      normalizedText: normalizeContent("The database is MySQL."),
    });
    assert.notEqual(match, null);
    assert.equal(match!.matchedTier, "exact");
    assert.equal(match!.tombstoneId, id);
  });

  it("blocks a normalized-text match ignoring punctuation/case", async () => {
    const env = await makeStore("default");
    await env.store.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-2",
      rawContent: "We use PostgreSQL for the main DB.",
    });
    await env.store.load();
    const match = env.store.lookup({
      namespace: "default",
      normalizedText: normalizeContent("we use postgresql for the main db!!!"),
    });
    assert.notEqual(match, null);
    assert.equal(match!.matchedTier, "normalized");
  });

  it("blocks a keyed (entityRef + supersessionKey) match", async () => {
    const env = await makeStore("default");
    await env.store.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-3",
      rawContent: "Acme's HQ is in London.",
      entityRef: "entity-acme",
      supersessionKey: "entity-acme::hq_city",
    });
    await env.store.load();
    const match = env.store.lookup({
      namespace: "default",
      entityRef: "entity-acme",
      supersessionKey: "entity-acme::hq_city",
    });
    assert.notEqual(match, null);
    assert.equal(match!.matchedTier, "keyed");
  });

  it("returns null when nothing matches", async () => {
    const env = await makeStore("default");
    await env.store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-1",
      rawContent: "The database is MySQL.",
    });
    await env.store.load();
    const match = env.store.lookup({
      namespace: "default",
      contentHash: computeHash("something completely different"),
    });
    assert.equal(match, null);
  });
});

describe("TombstoneStore — Unicode normalizer migration", () => {
  it("migrates a legacy Japanese identity before indexing, then survives restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-unicode-migration-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const japanese = "利用者は紅茶を好む。";
    const legacyNormalize = (content: string) =>
      content.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const legacyEntry = {
      id: "tomb-legacy-japanese",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-japanese",
      contentHash: createHash("sha256").update(legacyNormalize(japanese)).digest("hex"),
      normalizedText: legacyNormalize(japanese),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    const legacyAscii = {
      ...legacyEntry,
      id: "tomb-legacy-ascii",
      sourceMemoryId: "fact-ascii",
      contentHash: createHash("sha256").update(legacyNormalize("ASCII survives")).digest("hex"),
      normalizedText: legacyNormalize("ASCII survives"),
    };
    await writeFile(
      filePath,
      `${JSON.stringify(legacyEntry)}\n${JSON.stringify(legacyAscii)}\n`,
      "utf8",
    );
    const options = {
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
      sourceContentsForMemoryIds: async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, id === "fact-japanese" ? japanese : "ASCII survives"])),
    };
    const store = new TombstoneStore(filePath, "default", options, makeIo());
    await store.load();
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(japanese) })?.matchedTier,
      "exact",
    );
    assert.equal(
      store.lookup({ namespace: "default", normalizedText: normalizeContent(japanese) })?.matchedTier,
      "normalized",
    );
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash("ASCII survives") })?.matchedTier,
      "exact",
    );
    assert.equal(store.snapshot().find((entry) => entry.id === legacyEntry.id)?.normalizerVersion, 2);

    const restarted = new TombstoneStore(filePath, "default", options, makeIo());
    await restarted.load();
    assert.equal(
      restarted.lookup({ namespace: "default", contentHash: computeHash(japanese) })?.matchedTier,
      "exact",
    );
    assert.equal(
      restarted.lookup({ namespace: "default", normalizedText: normalizeContent(japanese) })?.matchedTier,
      "normalized",
    );
    assert.equal(
      restarted.lookup({ namespace: "default", contentHash: computeHash("ASCII survives") })?.matchedTier,
      "exact",
    );
  });

  it("preserves an explicit pre-upgrade contentHashSource identity after migration and restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-content-hash-source-migration-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "利用者は紅茶を好む。";
    const override = computeHash("external contentHashSource identity");
    const legacyNormalize = (content: string) =>
      content.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const legacyEntry = {
      id: "tomb-legacy-override",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-override",
      contentHash: override,
      normalizedText: legacyNormalize(source),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    await writeFile(filePath, `${JSON.stringify(legacyEntry)}\n`, "utf8");
    const options = {
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
      sourceContentsForMemoryIds: async () =>
        new Map<string, string>([["fact-override", source]]),
    };
    const store = new TombstoneStore(filePath, "default", options, makeIo());
    await store.load();
    const query = {
      namespace: "default",
      contentHash: override,
      normalizedText: normalizeContent(source),
    };
    assert.equal(store.lookup(query)?.matchedTier, "exact");

    const restarted = new TombstoneStore(filePath, "default", options, makeIo());
    await restarted.load();
    assert.equal(restarted.lookup(query)?.matchedTier, "exact");
  });
});

describe("TombstoneStore — Unicode migration safety", () => {
  it("does not cross-block unrelated pure-CJK tombstones through an empty legacy alias", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-cjk-alias-safety-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const first = "利用者は紅茶を好む。";
    const unrelated = "利用者は珈琲を好む。";
    const legacyHash = computeLegacyContentHash(first);
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-cjk-first",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-cjk-first",
        contentHash: legacyHash,
        normalizedText: normalizeLegacyContent(first),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8",
    );
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () =>
          new Map<string, string>([["fact-cjk-first", first]]),
      },
      makeIo(),
    );
    await store.load();
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(first) })?.matchedTier,
      "exact",
    );
    assert.equal(
      store.lookup({
        namespace: "default",
        contentHash: computeHash(unrelated),
      }),
      null,
    );
  });

  it("does not publish legacy identities when migration fails and retries on the next load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-retry-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "利用者は緑茶を好む。";
    const legacyEntry = {
      id: "tomb-migration-retry",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-migration-retry",
      contentHash: computeLegacyContentHash(source),
      normalizedText: normalizeLegacyContent(source),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    await writeFile(filePath, `${JSON.stringify(legacyEntry)}\n`, "utf8");
    let sourceReadAttempts = 0;
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () => {
          sourceReadAttempts += 1;
          if (sourceReadAttempts === 1) throw new Error("transient source read failure");
          return new Map<string, string>([[legacyEntry.sourceMemoryId, source]]);
        },
      },
      makeIo(),
    );

    await assert.rejects(store.load(), /transient source read failure/);
    assert.deepEqual(store.snapshot(), []);
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(source) }),
      null,
    );

    await store.load();
    assert.equal(sourceReadAttempts, 2);
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier,
      "exact",
    );
  });

  it("does not publish an empty index after a transient ledger read failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-load-retry-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "Current tombstone identity";
    const entry = {
      id: "tomb-load-retry",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-load-retry",
      contentHash: computeHash(source),
      normalizedText: normalizeContent(source),
      normalizerVersion: 2,
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    let readAttempts = 0;
    const io = makeIo();
    io.read = async (target) => {
      readAttempts += 1;
      if (readAttempts === 1) {
        const error = new Error("transient ledger read failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return readFile(target, "utf8");
    };
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
      },
      io,
    );

    await assert.rejects(store.load(), /transient ledger read failure/);
    assert.deepEqual(store.snapshot(), []);

    await store.load();
    assert.equal(readAttempts, 2);
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier,
      "exact",
    );
  });

  it("withholds unverified legacy hash tiers until the source becomes available", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-unverified-legacy-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "The user prefers café.";
    const collision = "The user prefers caf.";
    const legacyEntry = {
      id: "tomb-unverified-legacy",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-unverified-legacy",
      contentHash: computeLegacyContentHash(source),
      normalizedText: normalizeLegacyContent(source),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    await writeFile(filePath, `${JSON.stringify(legacyEntry)}\n`, "utf8");
    let sourceAvailable = false;
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: true,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        semanticSimilarity: () => 1,
        sourceContentsForMemoryIds: async () =>
          sourceAvailable
            ? new Map<string, string>([[legacyEntry.sourceMemoryId, source]])
            : new Map(),
      },
      makeIo(),
    );

    await store.load();
    assert.equal(store.snapshot()[0]?.normalizerVersion, undefined);
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(collision) }),
      null,
    );
    assert.equal(
      store.lookup({ namespace: "default", normalizedText: normalizeContent(collision) }),
      null,
    );

    sourceAvailable = true;
    store.invalidate();
    await store.load();
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier,
      "exact",
    );
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(collision) }),
      null,
    );
  });

  it("replaces a mixed-Unicode legacy hash instead of blocking its ASCII collision", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-mixed-unicode-alias-safety-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "The user prefers café.";
    const asciiCollision = "The user prefers caf.";
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-mixed-unicode",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-mixed-unicode",
        contentHash: computeLegacyContentHash(source),
        normalizedText: normalizeLegacyContent(source),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8",
    );
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () =>
          new Map<string, string>([["fact-mixed-unicode", source]]),
      },
      makeIo(),
    );
    await store.load();

    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier,
      "exact",
    );
    assert.equal(
      store.lookup({ namespace: "default", contentHash: computeHash(asciiCollision) }),
      null,
    );
  });

  it("migrates the raw source identity when a stored fact has structured attributes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-attribute-source-migration-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "利用者は紅茶を好む。";
    const storedBody = `${source}\n[Attributes: topic: 紅茶]`;
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-attribute-source",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-attribute-source",
        contentHash: computeLegacyContentHash(source),
        normalizedText: normalizeLegacyContent(source),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8"
    );
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () => new Map([["fact-attribute-source", [storedBody, source]]]),
      },
      makeIo()
    );
    await store.load();

    assert.equal(store.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier, "exact");
    assert.equal(store.snapshot()[0]?.normalizerVersion, 2);
  });

  it("does not finalize migration from a body with an unrecognized stale citation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-stale-citation-migration-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "The user prefers café.";
    const storedBody = `${source} [legacy-source:planner]`;
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-stale-citation",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-stale-citation",
        contentHash: computeLegacyContentHash(source),
        normalizedText: normalizeLegacyContent(source),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8",
    );
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () =>
          new Map<string, string>([["fact-stale-citation", storedBody]]),
      },
      makeIo(),
    );
    await store.load();

    const entry = store.snapshot()[0];
    assert.equal(entry?.normalizerVersion, undefined);
    assert.equal(entry?.currentContentHashAlias, undefined);
  });

  it("migrates valid rows while preserving malformed JSONL rows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-corrupt-migration-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "The user prefers café.";
    const valid = JSON.stringify({
      id: "tomb-corrupt-migration",
      kind: "tombstone",
      reason: "correction",
      sourceMemoryId: "fact-corrupt-migration",
      contentHash: computeLegacyContentHash(source),
      normalizedText: normalizeLegacyContent(source),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction",
    });
    const original = `${valid}\n{not-json}\n`;
    await writeFile(filePath, original, "utf8");
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () =>
          new Map<string, string>([["fact-corrupt-migration", source]]),
      },
      makeIo(),
    );
    await store.load();

    const rewritten = await readFile(filePath, "utf8");
    assert.equal(rewritten.split("\n")[1], "{not-json}");
    assert.equal(rewritten.endsWith("{not-json}\n"), true);
    assert.equal(store.snapshot()[0]?.normalizerVersion, 2);
    assert.equal(store.snapshot()[0]?.contentHash, computeHash(source));
    assert.equal(store.stats().corruptedLines, 1);
  });

  it("blocks the same pure-CJK body without cross-blocking an unrelated body", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-cjk-override-safety-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "東京の会社は紅茶を好む。";
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-cjk-override",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-cjk-override",
        contentHash: computeLegacyContentHash(source),
        normalizedText: normalizeLegacyContent(source),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8",
    );
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        sourceContentsForMemoryIds: async () =>
          new Map<string, string>([["fact-cjk-override", source]]),
      },
      makeIo(),
    );
    await store.load();
    assert.equal(
      store.lookup({ namespace: "default", normalizedText: normalizeContent(source) })?.matchedTier,
      "normalized",
    );
    assert.equal(
      store.lookup({ namespace: "default", normalizedText: normalizeContent("大阪の会社は珈琲を好む。") }),
      null,
    );
  });

  it("rejects invalid legacy migration limits and accepts zero", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-limit-"));
    const options = {
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
    };
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new TombstoneStore(path.join(dir, `${String(limit)}.jsonl`), "default", { ...options, legacyMigrationLimit: limit }, makeIo()),
        /legacyMigrationLimit must be a finite non-negative integer/,
      );
    }
    assert.doesNotThrow(
      () => new TombstoneStore(path.join(dir, "zero.jsonl"), "default", { ...options, legacyMigrationLimit: 0 }, makeIo()),
    );
  });

  it("retries a missing migration source after restart and upgrades when it appears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-missing-source-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const source = "The user prefers café.";
    await writeFile(
      filePath,
      `${JSON.stringify({
        id: "tomb-missing-source",
        kind: "tombstone",
        reason: "correction",
        sourceMemoryId: "fact-missing-source",
        contentHash: computeLegacyContentHash(source),
        normalizedText: normalizeLegacyContent(source),
        namespace: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user_correction",
      })}\n`,
      "utf8",
    );
    let requests = 0;
    let sourceAvailable = false;
    const options = {
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
      sourceContentsForMemoryIds: async () => {
        requests += 1;
        return new Map<string, string>(
          sourceAvailable ? [["fact-missing-source", source]] : [],
        );
      },
    };
    const first = new TombstoneStore(filePath, "default", options, makeIo());
    await first.load();
    assert.equal(requests, 1);
    assert.equal(first.lookup({ namespace: "default", contentHash: computeHash(source) }), null);

    sourceAvailable = true;
    const restarted = new TombstoneStore(filePath, "default", options, makeIo());
    await restarted.load();
    assert.equal(requests, 2);
    assert.equal(
      restarted.lookup({ namespace: "default", contentHash: computeHash(source) })?.matchedTier,
      "exact",
    );
  });

  it("migrates every legacy entry before one load becomes authoritative", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-all-batches-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "tombstones.jsonl");
    const sources = new Map([
      ["fact-first", "利用者は紅茶を好む。"],
      ["fact-second", "利用者は珈琲を好む。"],
    ]);
    const entries = [...sources].map(([sourceMemoryId, content], index) => ({
      id: `tomb-batch-${index}`,
      kind: "tombstone",
      reason: "correction",
      sourceMemoryId,
      contentHash: computeLegacyContentHash(content),
      normalizedText: normalizeLegacyContent(content),
      namespace: "default",
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      createdBy: "user_correction",
    }));
    await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const requestedBatches: string[][] = [];
    const store = new TombstoneStore(
      filePath,
      "default",
      {
        enabled: true,
        semanticMatch: false,
        semanticThreshold: 0.9,
        hashContent: computeHash,
        normalizeText: normalizeContent,
        legacyMigrationLimit: 1,
        sourceContentsForMemoryIds: async (sourceMemoryIds) => {
          requestedBatches.push([...sourceMemoryIds]);
          return new Map(sourceMemoryIds.map((id) => [id, sources.get(id) as string]));
        },
      },
      makeIo(),
    );

    await store.load();

    assert.deepEqual(requestedBatches, [["fact-first"], ["fact-second"]]);
    for (const content of sources.values()) {
      assert.equal(
        store.lookup({ namespace: "default", contentHash: computeHash(content) })?.matchedTier,
        "exact",
      );
    }
  });
});

describe("TombstoneStore — revocation supersedes tombstone", () => {
  it("a revocation entry re-allows the fact (newest wins)", async () => {
    const env = await makeStore("default");
    const tombId = await env.store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-x",
      rawContent: "The API runs on port 3000.",
    });
    await env.store.load();
    assert.notEqual(
      env.store.lookup({ namespace: "default", contentHash: computeHash("The API runs on port 3000.") }),
      null,
    );
    await env.store.revoke(tombId, "user_correction");
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeHash("The API runs on port 3000.") }),
      null,
    );
  });

  it("revocation round-trips through disk reload", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-rt-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const io = makeIo();
    const opts = { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: computeHash, normalizeText: normalizeContent };
    const store = new TombstoneStore(filePath, "default", opts, io);
    const tombId = await store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-y",
      rawContent: "Server is down.",
    });
    await store.revoke(tombId, "user_correction");
    // New store instance over the same file → must reproduce the revoked state.
    const store2 = new TombstoneStore(filePath, "default", opts, io);
    await store2.load();
    assert.equal(
      store2.lookup({ namespace: "default", contentHash: computeHash("Server is down.") }),
      null,
    );
  });
});

describe("TombstoneStore — rebuild identity preservation (issue #2367)", () => {
  it("repairs a CJK collision instead of indexing the empty legacy skeleton (issue #2367)", async () => {
    const env = await makeStore("default");
    // Two distinct CJK-only strings collide under the lossy legacy normalizer
    // (both skeletons are empty), so a persisted legacy hash of the source
    // numerically equals the legacy hash of the body. The empty skeleton
    // identifies nothing, so rebuild must repair the row to the current body
    // hash rather than publish the collision key on the exact tier.
    const source = "利用者は紅茶を好む。";
    const body = "利用者は珈琲を好む。";
    const unrelated = "利用者は抹茶を好む。";
    const persistedHash = computeLegacyContentHash(source);
    assert.equal(persistedHash, computeLegacyContentHash(body));
    assert.notEqual(computeHash(source), computeHash(body));

    await env.store.rebuild([
      {
        memoryId: "fact-cjk-override",
        rawContent: body,
        contentHash: persistedHash,
        reason: "correction",
        createdBy: "user_correction",
        createdAt: "2026-01-01T:00:00:00.000Z",
      },
    ]);

    const entry = env.store.snapshot().find((e) => e.kind === "tombstone");
    assert.ok(entry);
    assert.equal(entry.contentHash, computeHash(body));
    assert.equal(entry.currentContentHashAlias, undefined);
    // The body stays blocked; the shared empty-skeleton key is NOT indexed,
    // so unrelated CJK bodies (and empty-content writes) are not blocked
    // through it.
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeHash(body) })?.matchedTier,
      "exact",
    );
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeHash(unrelated) }),
      null,
    );
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeLegacyContentHash(unrelated) }),
      null,
    );
  });

  it("preserves a persisted hash whose ASCII skeleton collides with an accented body", async () => {
    const env = await makeStore("default");
    const body = "The user prefers café.";
    await env.store.rebuild([
      {
        memoryId: "fact-accented-override",
        rawContent: body,
        contentHash: computeLegacyContentHash(body),
        reason: "correction",
        createdBy: "user_correction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const entry = env.store.snapshot().find((e) => e.kind === "tombstone");
    assert.ok(entry);
    // The legacy equality is ambiguous (the skeleton "the user prefers caf"
    // is shared with distinct strings), so the persisted identity is kept and
    // the current body hash rides along as the alias.
    assert.equal(entry.contentHash, computeLegacyContentHash(body));
    assert.equal(entry.currentContentHashAlias, computeHash(body));
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeHash(body) })?.matchedTier,
      "exact",
    );
  });

  it("keeps a single identity when the persisted hash already equals the current body hash", async () => {
    const env = await makeStore("default");
    const body = "The cache uses Redis.";
    await env.store.rebuild([
      {
        memoryId: "fact-unambiguous",
        rawContent: body,
        contentHash: computeLegacyContentHash(body),
        reason: "correction",
        createdBy: "user_correction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const entry = env.store.snapshot().find((e) => e.kind === "tombstone");
    assert.ok(entry);
    // Pure-ASCII body: legacy and current normalizers agree, so the legacy
    // hash equals the current hash and there is nothing to preserve.
    assert.equal(entry.contentHash, computeHash(body));
    assert.equal(entry.currentContentHashAlias, undefined);
  });
});

describe("TombstoneStore — rebuild equivalence", () => {
  it("rebuild from a fixture corpus reproduces identical lookup decisions", async () => {
    const env = await makeStore("default");
    const retired = [
      {
        memoryId: "fact-a",
        rawContent: "The cache uses Redis.",
        reason: "correction" as const,
        createdBy: "user_correction" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        memoryId: "fact-b",
        rawContent: "Deployments happen on Fridays.",
        entityRef: "entity-deploy",
        supersessionKey: "entity-deploy::day",
        reason: "supersession" as const,
        createdBy: "supersession" as const,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    await env.store.rebuild(retired);
    const d1 = env.store.lookup({ namespace: "default", contentHash: computeHash("The cache uses Redis.") });
    const d2 = env.store.lookup({ namespace: "default", entityRef: "entity-deploy", supersessionKey: "entity-deploy::day" });
    assert.equal(d1?.matchedTier, "exact");
    assert.equal(d2?.matchedTier, "keyed");

    // Delete the JSONL, rebuild from the same corpus via a fresh store → identical decisions.
    await rm(path.join(env.dir, "state", "tombstones.jsonl"), { force: true });
    const env2 = await makeStore("default");
    await env2.store.rebuild(retired);
    const e1 = env2.store.lookup({ namespace: "default", contentHash: computeHash("The cache uses Redis.") });
    const e2 = env2.store.lookup({ namespace: "default", entityRef: "entity-deploy", supersessionKey: "entity-deploy::day" });
    assert.equal(e1?.matchedTier, d1?.matchedTier);
    assert.equal(e2?.matchedTier, d2?.matchedTier);
    assert.equal(e1?.reason, d1?.reason);
    assert.equal(e2?.reason, d2?.reason);
  });

  it("rebuild produces byte-stable output for a fixed corpus (modulo id)", async () => {
    const env = await makeStore("default");
    const retired = [
      { memoryId: "fact-a", rawContent: "X.", reason: "correction" as const, createdBy: "user_correction" as const, createdAt: "2026-01-01T00:00:00.000Z" },
      { memoryId: "fact-b", rawContent: "Y.", reason: "supersession" as const, createdBy: "supersession" as const, createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    await env.store.rebuild(retired);
    const first = await readFile(path.join(env.dir, "state", "tombstones.jsonl"), "utf8");
    await env.store.rebuild(retired);
    const second = await readFile(path.join(env.dir, "state", "tombstones.jsonl"), "utf8");
    const parseLines = (raw: string) =>
      raw.split("\n").filter((l) => l.trim()).map((l) => {
        const { id, ...rest } = JSON.parse(l);
        return rest;
      });
    assert.deepEqual(parseLines(second), parseLines(first));
    assert.equal(
      second.split("\n").filter((l) => l.trim()).length,
      first.split("\n").filter((l) => l.trim()).length,
    );
  });
});

describe("TombstoneStore — corrupted line skipped with counter, not crash", () => {
  it("skips malformed lines and counts them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-corrupt-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const good = {
      id: "tomb-good-1",
      kind: "tombstone",
      reason: "correction",
      sourceMemoryId: "fact-1",
      contentHash: computeHash("good content"),
      normalizedText: normalizeContent("good content"),
      normalizerVersion: 2,
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction",
    };
    const raw = [
      JSON.stringify(good),
      "this is not json {{{",
      "",
      JSON.stringify({ ...good, id: "tomb-good-2", reason: "INVALID_REASON" }),
      JSON.stringify({ ...good, id: "tomb-good-2", kind: "tombstone", reason: "supersession" }),
    ].join("\n");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, raw, "utf8");
    const store = new TombstoneStore(
      filePath,
      "default",
      { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: computeHash, normalizeText: normalizeContent },
      makeIo(),
    );
    await store.load();
    const stats = store.stats();
    assert.equal(stats.count, 2);
    assert.equal(stats.corruptedLines, 2);
    assert.notEqual(
      store.lookup({ namespace: "default", contentHash: computeHash("good content") }),
      null,
    );
  });
});

describe("TombstoneStore — concurrent appends serialize", () => {
  it("parallel appends all land on disk without interleaving", async () => {
    const env = await makeStore("default");
    const contents = Array.from({ length: 20 }, (_, i) => `fact content ${i}`);
    await Promise.all(
      contents.map((c) =>
        env.store.appendTombstone({
          reason: "correction",
          createdBy: "user_correction",
          sourceMemoryId: `fact-${c}`,
          rawContent: c,
        }),
      ),
    );
    await env.store.load();
    const stats = env.store.stats();
    assert.equal(stats.count, 20);
    const raw = await readFile(path.join(env.dir, "state", "tombstones.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 20);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

describe("TombstoneStore — namespace isolation", () => {
  it("a tombstone in namespace A never blocks namespace B", async () => {
    const a = await makeStore("ns-a");
    const b = await makeStore("ns-b");
    await a.store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-ns-a",
      rawContent: "Shared text content.",
    });
    await a.store.load();
    await b.store.load();
    assert.notEqual(
      a.store.lookup({ namespace: "ns-a", contentHash: computeHash("Shared text content.") }),
      null,
    );
    assert.equal(
      b.store.lookup({ namespace: "ns-b", contentHash: computeHash("Shared text content.") }),
      null,
    );
  });
});

describe("TombstoneStore — enabled gate (rule 30)", () => {
  it("returns null when disabled (rollback safety)", async () => {
    const env = await makeStore("default", { enabled: false });
    await env.store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-1",
      rawContent: "Disabled gate content.",
    });
    await env.store.load();
    assert.equal(
      env.store.lookup({ namespace: "default", contentHash: computeHash("Disabled gate content.") }),
      null,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process tombstone write lock (issue #1639)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A read-merge-write file io that simulates the secure-store append path
 * (read encrypted → decrypt → concat → re-encrypt → atomic rename). Unlike a
 * raw O_APPEND, this is NOT atomic across processes: two writers that each
 * read the same contents and write back drop the other line — the exact
 * lost-write race the #1639 cross-process lock closes. The setImmediate yield
 * widens the race window so a missing lock would demonstrably lose entries.
 */
function makeReadMergeWriteIo() {
  return {
    read: (p: string) => readFile(p, "utf8"),
    append: async (p: string, c: string) => {
      await mkdir(path.dirname(p), { recursive: true });
      let existing = "";
      try {
        existing = await readFile(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Yield so two concurrent read-merge-write appends observably overlap
      // when the cross-process lock is absent.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writeFile(p, existing + c, "utf8");
    },
    write: async (p: string, c: string) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, c, "utf8");
    },
    stat: (p: string) => statSync(p),
  };
}

describe("TombstoneStore — cross-process write lock (issue #1639)", () => {
  it("two processes appending concurrently produce no lost entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-xproc-"));
    const moduleUrl = new URL("./tombstones.ts", import.meta.url).href;
    const entriesPerWorker = 15;

    // Worker source: plain JS, no nested template literals. Each child imports
    // the store, points it at the shared tombstones.jsonl with a read-merge-
    // write io, and appends N entries. The cross-process lock serializes the
    // appends across the two processes so no entry is dropped.
    const workerSource = [
      "(async () => {",
      "const { TombstoneStore } = await import(process.argv[1]);",
      "const { mkdir, readFile, writeFile } = await import(\"node:fs/promises\");",
      "const { statSync } = await import(\"node:fs\");",
      "const path = await import(\"node:path\");",
      "const { createHash } = await import(\"node:crypto\");",
      "const dir = process.argv[2];",
      "const workerId = Number(process.argv[3]);",
      "const count = Number(process.argv[4]);",
      "const filePath = path.join(dir, \"tombstones.jsonl\");",
      "function hash(c){return createHash(\"sha256\").update(c).digest(\"hex\");}",
      "function normalize(c){return c;}",
      "const io = {",
      "  read: (p) => readFile(p, \"utf8\"),",
      "  append: async (p, c) => {",
      "    await mkdir(path.dirname(p), { recursive: true });",
      "    let existing = \"\";",
      "    try { existing = await readFile(p, \"utf8\"); } catch (e) { if (e.code !== \"ENOENT\") throw e; }",
      "    await new Promise((r) => setImmediate(r));",
      "    await writeFile(p, existing + c, \"utf8\");",
      "  },",
      "  write: async (p, c) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, c, \"utf8\"); },",
      "  stat: (p) => statSync(p),",
      "};",
      "const store = new TombstoneStore(filePath, \"default\", { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: hash, normalizeText: normalize }, io);",
      "await store.load();",
      "for (let i = 0; i < count; i += 1) {",
      "  await store.appendTombstone({ reason: \"correction\", createdBy: \"user_correction\", sourceMemoryId: \"w\" + workerId + \"-f\" + i, rawContent: \"worker \" + workerId + \" fact \" + i });",
      "}",
      "})();",
    ].join("\n");

    function runWorker(workerId: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "-e", workerSource, moduleUrl, dir, String(workerId), String(entriesPerWorker)],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`));
        });
      });
    }

    // Two genuinely concurrent processes contending on the same lockfile.
    await Promise.all([runWorker(0), runWorker(1)]);

    const raw = await readFile(path.join(dir, "tombstones.jsonl"), "utf8");
    const fileLines = raw.split("\n").filter((l) => l.trim().length > 0);
    // No lost entries: every line parses and the total is exactly 2 × N.
    assert.equal(fileLines.length, entriesPerWorker * 2);
    for (const line of fileLines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    // Every worker entry is present (none dropped by a lost write).
    const sourceIds = new Set(fileLines.map((l) => JSON.parse(l).sourceMemoryId));
    for (let w = 0; w < 2; w += 1) {
      for (let i = 0; i < entriesPerWorker; i += 1) {
        assert.ok(sourceIds.has(`w${w}-f${i}`), `missing w${w}-f${i} — lost write`);
      }
    }
    // The advisory lockfile is released after the run (no lingering lock).
    await rm(path.join(dir, "tombstones.lock"), { force: true });
  });

  it("recovers from a stale lock left by a crashed holder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-stale-lock-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const lockPath = path.join(dir, "tombstones.lock");
    // Seed a lockfile written by a (now-crashed) holder: <pid> <uuid> <iso>.
    await mkdir(dir, { recursive: true });
    await writeFile(
      lockPath,
      `${process.pid} 00000000-0000-0000-0000-000000000000 2000-01-01T00:00:00.000Z\n`,
      "utf8",
    );
    // Make it older than staleMs so the next acquire breaks it.
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const store = new TombstoneStore(
      filePath,
      "default",
      { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: computeHash, normalizeText: normalizeContent, lockStaleMs: 1_000 },
      makeReadMergeWriteIo(),
    );
    // The append must break the stale lock, acquire a fresh one, and succeed.
    const id = await store.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-stale",
      rawContent: "Recovered from a stale lock.",
    });
    assert.match(id, /^tomb-/);
    // The tombstone landed durably.
    const raw = await readFile(filePath, "utf8");
    const lines2 = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines2.length, 1);
    // Our fresh lock was released on completion (the stale one was broken).
    await rm(lockPath, { force: true });
  });

  it("does not deadlock when mtime freshness sees legacy entries before append or rebuild", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-deadlock-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const japanese = "利用者は紅茶を好む。";
    const legacyNormalize = (content: string) =>
      content.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const legacyEntry = {
      id: "tomb-legacy-before-append",
      kind: "tombstone" as const,
      reason: "correction" as const,
      sourceMemoryId: "fact-legacy-before-append",
      contentHash: createHash("sha256").update(legacyNormalize(japanese)).digest("hex"),
      normalizedText: legacyNormalize(japanese),
      namespace: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_correction" as const,
    };
    let resolveSources = false;
    const options = {
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      hashContent: computeHash,
      normalizeText: normalizeContent,
      sourceContentsForMemoryIds: async (ids: readonly string[]) =>
        resolveSources
          ? new Map(ids.map((id) => [id, japanese]))
          : new Map<string, string>(),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    const withTurnTimeout = async <T>(operation: Promise<T>, message: string): Promise<T> => {
      let settled = false;
      const timeout = new Promise<never>((_, reject) => {
        let turns = 0;
        const check = () => {
          if (settled) return;
          turns += 1;
          if (turns >= 100_000) reject(new Error(message));
          else setImmediate(check);
        };
        setImmediate(check);
      });
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        settled = true;
      }
    };
    await writeFile(filePath, `${JSON.stringify(legacyEntry)}\n`, "utf8");
    const store = new TombstoneStore(filePath, "default", options, makeReadMergeWriteIo());
    await store.load();
    resolveSources = true;

    const peerEntry = {
      ...legacyEntry,
      id: "tomb-peer-before-append",
      sourceMemoryId: "fact-peer",
    };
    await appendFile(filePath, `${JSON.stringify(peerEntry)}\n`, "utf8");
    const appendMtime = new Date(Date.now() + 2_000);
    await utimes(filePath, appendMtime, appendMtime);
    const appended = await withTurnTimeout(
      store.appendTombstone({
        reason: "correction",
        createdBy: "user_correction",
        sourceMemoryId: "fact-new",
        rawContent: "A new fact after the peer append.",
      }),
      "append migration deadlock",
    );
    assert.match(appended, /^tomb-/);

    const rebuildPeer = {
      ...legacyEntry,
      id: "tomb-peer-before-rebuild",
      sourceMemoryId: "fact-peer-rebuild",
    };
    await appendFile(filePath, `${JSON.stringify(rebuildPeer)}\n`, "utf8");
    const rebuildMtime = new Date(Date.now() + 4_000);
    await utimes(filePath, rebuildMtime, rebuildMtime);
    const rebuilt = await withTurnTimeout(
      store.rebuild([
        {
          memoryId: "fact-rebuild",
          rawContent: japanese,
          reason: "correction" as const,
          createdBy: "user_correction" as const,
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
      "rebuild migration deadlock",
    );
    assert.equal(rebuilt, 1);
  });

  it("rebuild preserves a peer's revocation appended before rebuild acquired the lock (cursor/codex #1639)", async () => {
    // Regression for the rebuild race: rebuild must re-read the log under the
    // lock (ensureFreshAgainstDisk) before computing its payload, otherwise a
    // revocation a peer wrote while rebuild waited for the lock is dropped and
    // the retired fact silently un-revokes (resurrection).
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-rebuild-race-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const moduleUrl = new URL("./tombstones.ts", import.meta.url).href;
    const opts = { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: computeHash, normalizeText: normalizeContent };
    const io = makeReadMergeWriteIo();
    // Store A writes tombstone-1, then goes stale (never sees the peer write).
    const storeA = new TombstoneStore(filePath, "default", opts, io);
    const t1 = await storeA.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-rebuild-1",
      rawContent: "The DB is MySQL.",
    });
    // A real peer process revokes t1. Its append callback runs only after the
    // peer holds the advisory write lock, so LOCK_HELD is a deterministic
    // handshake: store A starts rebuilding while the peer still owns the
    // lock, then RELEASE lets the peer durably append before A can acquire it.
    const workerSource = [
      "(async () => {",
      "const { TombstoneStore } = await import(process.argv[1]);",
      "const { mkdir, readFile, writeFile } = await import(\"node:fs/promises\");",
      "const { statSync } = await import(\"node:fs\");",
      "const path = await import(\"node:path\");",
      "const { createHash } = await import(\"node:crypto\");",
      "const filePath = path.join(process.argv[2], \"tombstones.jsonl\");",
      "const tombstoneId = process.argv[3];",
      "let release;",
      "const released = new Promise((resolve) => { release = resolve; });",
      "process.stdin.setEncoding(\"utf8\");",
      "process.stdin.once(\"data\", (chunk) => { if (chunk.trim() === \"RELEASE\") release(); });",
      "function hash(c){return createHash(\"sha256\").update(c).digest(\"hex\");}",
      "function normalize(c){return c;}",
      "const io = {",
      "  read: (p) => readFile(p, \"utf8\"),",
      "  append: async (p, c) => {",
      "    await mkdir(path.dirname(p), { recursive: true });",
      "    let existing = \"\";",
      "    try { existing = await readFile(p, \"utf8\"); } catch (e) { if (e.code !== \"ENOENT\") throw e; }",
      "    process.stdout.write(\"LOCK_HELD\\n\");",
      "    await released;",
      "    await writeFile(p, existing + c, \"utf8\");",
      "  },",
      "  write: async (p, c) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, c, \"utf8\"); },",
      "  stat: (p) => statSync(p),",
      "};",
      "const store = new TombstoneStore(filePath, \"default\", { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: hash, normalizeText: normalize }, io);",
      "await store.revoke(tombstoneId, \"user_correction\");",
      "process.stdout.write(\"DONE\\n\");",
      "})().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n");

    const peer = spawn(
      process.execPath,
      ["--import", "tsx", "-e", workerSource, moduleUrl, dir, t1],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let stdout = "";
    let lockHeld = false;
    let resolveLockHeld!: () => void;
    let rejectLockHeld!: (error: Error) => void;
    const peerLockHeld = new Promise<void>((resolve, reject) => {
      resolveLockHeld = resolve;
      rejectLockHeld = reject;
    });
    peer.stdout.setEncoding("utf8");
    peer.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!lockHeld && stdout.split("\n").includes("LOCK_HELD")) {
        lockHeld = true;
        resolveLockHeld();
      }
    });
    peer.stderr.setEncoding("utf8");
    peer.stderr.on("data", (chunk) => { stderr += chunk; });
    peer.on("error", (error) => rejectLockHeld(error));
    const peerCompleted = new Promise<void>((resolve, reject) => {
      peer.on("close", (code) => {
        if (!lockHeld) {
          rejectLockHeld(new Error(`revocation peer exited before acquiring lock (${code}): ${stderr}`));
        }
        if (code === 0 && stdout.split("\n").includes("DONE")) resolve();
        else reject(new Error(`revocation peer exited ${code}: ${stderr}`));
      });
    });

    await peerLockHeld;
    // Store A rebuilds from a retired-memory corpus that reconstructs t1.
    // Without the under-lock re-read, A computes existingRevocations from its
    // stale index (empty), overwrites the file with [rebuilt-t1], and the
    // revocation is LOST — t1 is active again (resurrection). With the fix,
    // ensureFreshAgainstDisk reloads the revocation under the lock and rebuild
    // preserves it.
    const rebuild = storeA.rebuild([
      {
        memoryId: "fact-rebuild-1",
        rawContent: "The DB is MySQL.",
        reason: "correction" as const,
        createdBy: "user_correction" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    peer.stdin.end("RELEASE\n");
    await Promise.all([rebuild, peerCompleted]);
    // The rebuilt file must still contain the revocation (the retired fact
    // stays revoked, not silently un-revoked by the rebuild).
    const raw = await readFile(filePath, "utf8");
    const rebuiltLines = raw.split("\n").filter((l) => l.trim().length > 0);
    const hasRevocation = rebuiltLines.some((l) => {
      try { return JSON.parse(l).kind === "revocation"; } catch { return false; }
    });
    assert.ok(hasRevocation, "rebuild dropped the peer's revocation — resurrection risk");
    // And the rebuilt store A must report the fact as revoked (lookup returns null).
    await storeA.load();
    assert.equal(
      storeA.lookup({ namespace: "default", contentHash: computeHash("The DB is MySQL.") }),
      null,
      "revoked fact resurrected after rebuild",
    );
    await rm(path.join(dir, "tombstones.lock"), { force: true });
  });

  it("in-process concurrent appends still serialize under the lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tomb-inproc-lock-"));
    const filePath = path.join(dir, "tombstones.jsonl");
    const store = new TombstoneStore(
      filePath,
      "default",
      { enabled: true, semanticMatch: false, semanticThreshold: 0.9, hashContent: computeHash, normalizeText: normalizeContent },
      makeReadMergeWriteIo(),
    );
    const contents = Array.from({ length: 25 }, (_, i) => `locked content ${i}`);
    await Promise.all(
      contents.map((c) =>
        store.appendTombstone({
          reason: "correction",
          createdBy: "user_correction",
          sourceMemoryId: `fact-${c}`,
          rawContent: c,
        }),
      ),
    );
    await store.load();
    const raw = await readFile(filePath, "utf8");
    const lines3 = raw.split("\n").filter((l) => l.trim().length > 0);
    // No lost writes despite the read-merge-write io + concurrent appends.
    assert.equal(lines3.length, contents.length);
    assert.equal(store.stats().count, contents.length);
    await rm(path.join(dir, "tombstones.lock"), { force: true });
  });
});

describe("parseTombstoneLine", () => {
  it("rejects malformed input", () => {
    assert.equal(parseTombstoneLine(""), null);
    assert.equal(parseTombstoneLine("not json"), null);
    assert.equal(parseTombstoneLine(JSON.stringify({ id: "x" })), null);
    assert.equal(parseTombstoneLine(JSON.stringify({ kind: "tombstone" })), null);
  });
});
