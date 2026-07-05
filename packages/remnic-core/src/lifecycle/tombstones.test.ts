import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  TombstoneStore,
  parseTombstoneLine,
  type TombstoneFileIo,
} from "./tombstones.js";

// Mirror the dedup normalizer EXACTLY — these are the wired injections.
function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function computeHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}

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

describe("parseTombstoneLine", () => {
  it("rejects malformed input", () => {
    assert.equal(parseTombstoneLine(""), null);
    assert.equal(parseTombstoneLine("not json"), null);
    assert.equal(parseTombstoneLine(JSON.stringify({ id: "x" })), null);
    assert.equal(parseTombstoneLine(JSON.stringify({ kind: "tombstone" })), null);
  });
});
