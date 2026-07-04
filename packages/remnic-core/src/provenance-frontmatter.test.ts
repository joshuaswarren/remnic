import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import type { ProvenanceSource } from "./types.js";

/**
 * Issue #1575 PR 1 — Claim-level provenance spans: frontmatter schema +
 * storage round-trip.
 *
 * These tests pin the on-disk contract for the `sources` and `provenance`
 * frontmatter fields. They live in the core package (not the root tests/
 * directory) so they co-locate with storage.ts, where the parser/serializer
 * they cover resides — mirroring the `memory-worth-frontmatter.test.ts`
 * precedent (same package, same reason).
 *
 * Scope per PR 1:
 *   - Round-trip: explicit sources + provenance tag survive write → read
 *     intact, including optional offsets and a multi-source fact.
 *   - Legacy memories without the fields read cleanly (no crash) and return
 *     `undefined` (matching the accessCount / mw_* absent-field pattern).
 *   - Corrupt `sources` (string instead of array, entry missing `quote`)
 *     drop on read with the same "drop corrupt rather than poison" contract
 *     as `parseMemoryWorthCounterField`.
 *   - Serialized keys land in canonical order regardless of the in-memory
 *     object's key insertion order (rule 38 — deterministic output).
 *
 * Out of scope (later PRs in issue #1575):
 *   - Extraction prompt + per-fact `quote` output field (PR 2)
 *   - Post-parse validator that locates the quote in turn text (PR 2)
 *   - memory_get / x-ray / `remnic doctor` read surfaces (PR 3)
 */

/**
 * Build a fact file on disk with a bare-bones frontmatter plus arbitrary
 * extra lines. Used to synthesize legacy and instrumented memories without
 * going through `writeMemory`, which doesn't expose provenance options
 * (by design — those are set by the extraction validator in PR 2, not at
 * creation time).
 */
async function writeFactFile(
  storage: StorageManager,
  body: string,
  extraFrontmatterLines: string[] = [],
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    ...extraFrontmatterLines,
    "---",
  ];
  const factsDir = path.join((storage as unknown as { baseDir: string }).baseDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  await writeFile(path.join(factsDir, `${id}.md`), `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return id;
}

/** Resolve the on-disk path of a fact written by `writeFactFile`. */
function factFilePath(storage: StorageManager, id: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join((storage as unknown as { baseDir: string }).baseDir, "facts", today, `${id}.md`);
}

const TWO_SOURCES: ProvenanceSource[] = [
  {
    sessionKey: "project/acme/2026-05-03T10:00:00Z",
    turnId: "turn-42",
    observedAt: "2026-05-03T10:01:30Z",
    quote: "we migrated the production database to pgBouncer",
    charStart: 12,
    charEnd: 60,
  },
  {
    sessionKey: "project/acme/2026-05-10T14:00:00Z",
    observedAt: "2026-05-10T14:02:00Z",
    quote: "the connection pool now caps at 100",
  },
];

test("round-trip: two sources + provenance tag survive write → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Production DB uses pgBouncer with a 100-conn pool.");

    await storage.updateMemoryFrontmatter(id, { sources: TWO_SOURCES, provenance: "verified" });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "fact must be discoverable after write");
    assert.equal(written!.frontmatter.provenance, "verified");
    const sources = written!.frontmatter.sources;
    assert.ok(sources, "sources must round-trip");
    assert.equal(sources!.length, 2, "both sources survive");
    // First source retains every field, including optional offsets + turnId.
    assert.deepEqual(sources![0], TWO_SOURCES[0]);
    // Second source (no optional fields) round-trips without inventing any.
    assert.deepEqual(sources![1], TWO_SOURCES[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-trip: each provenance enum value survives write → read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-enum-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    for (const tag of ["verified", "unverified", "none"] as const) {
      const id = await writeFactFile(storage, `Fact tagged ${tag}.`);
      await storage.updateMemoryFrontmatter(id, { provenance: tag, sources: [TWO_SOURCES[0]!] });
      const memories = await storage.readAllMemories();
      const written = memories.find((m) => m.frontmatter.id === id);
      assert.ok(written);
      assert.equal(written!.frontmatter.provenance, tag, `tag ${tag} must round-trip`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy memory without provenance fields reads cleanly — both undefined", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Legacy fact pre-dating provenance spans.");

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "legacy fact must still be readable");
    assert.equal(written!.frontmatter.sources, undefined);
    assert.equal(written!.frontmatter.provenance, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt sources (string instead of array) drops to undefined on read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-string-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Hand-edited fact with a string-typed sources.", [
      'sources: "not an array"',
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    // A non-array value must NOT round-trip — it fails safely to undefined
    // so downstream surfaces aren't poisoned. See parseProvenanceSources.
    assert.equal(written!.frontmatter.sources, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt sources (not valid JSON) drops to undefined on read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-badjson-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Hand-edited fact with malformed JSON.", [
      "sources: [{not closed",
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry missing quote is dropped; sibling valid entry survives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-noquote-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    // One entry lacks the required `quote`; the other is well-formed. The
    // parser must drop the corrupt entry and keep the valid one rather than
    // poisoning the whole field or silently accepting bad data.
    const rawSources = JSON.stringify([
      { sessionKey: "s", observedAt: "2026-05-03T10:00:00Z" }, // missing quote → dropped
      TWO_SOURCES[0],
    ]);
    const id = await writeFactFile(storage, "Mixed valid/corrupt sources.", [
      `sources: ${rawSources}`,
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    const sources = written!.frontmatter.sources;
    assert.ok(sources, "valid entry must survive sibling corruption");
    assert.equal(sources!.length, 1, "corrupt entry is dropped, valid one kept");
    assert.deepEqual(sources![0], TWO_SOURCES[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry missing required sessionKey/observedAt is dropped, field undefined when alone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-alonemissing-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const rawSources = JSON.stringify([
      { observedAt: "2026-05-03T10:00:00Z", quote: "orphan quote with no session" },
    ]);
    const id = await writeFactFile(storage, "Single corrupt entry.", [
      `sources: ${rawSources}`,
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    // No valid entry survives → field is undefined (legacy-equivalent).
    assert.equal(written!.frontmatter.sources, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown provenance tag value drops to undefined on read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-badtag-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Hand-edited fact with bogus provenance tag.", [
      "provenance: definitely",
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.provenance, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serialized source keys land in canonical order regardless of insertion order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-keyorder-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact whose source object is keyed out of order.");

    // Deliberately build the object with keys in a scrambled order. The
    // serializer must emit them canonically: sessionKey, turnId, observedAt,
    // quote, charStart, charEnd (rule 38 — deterministic output).
    const scrambled: ProvenanceSource = {
      charEnd: 9,
      quote: "hello world",
      charStart: 0,
      observedAt: "2026-05-03T10:00:00Z",
      turnId: "t1",
      sessionKey: "s",
    };
    await storage.updateMemoryFrontmatter(id, { sources: [scrambled] });

    const raw = await readFile(factFilePath(storage, id), "utf-8");
    const sourcesLine = raw.split("\n").find((l) => l.startsWith("sources:"));
    assert.ok(sourcesLine, "sources line must be present");
    // The JSON object's keys must appear in canonical order.
    const keyOrder = sourcesLine!
      .slice("sources:".length)
      .trim()
      .replace(/^\[/, "")
      .replace(/]$/, "");
    const keys = [...keyOrder.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]);
    assert.deepEqual(keys, ["sessionKey", "turnId", "observedAt", "quote", "charStart", "charEnd"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("characterization: legacy frontmatter re-serializes without provenance keys", async () => {
  // When sources/provenance are absent, the serializer must emit NO
  // provenance lines so a legacy memory round-trips byte-identical for
  // these fields (rule 39 — byte-identical when the feature is off /
  // unused). This is the guard against accidentally emitting empty
  // `sources: []` or `provenance: none` placeholders.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-char-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Untouched legacy fact.");

    // Force a re-serialize by bumping an unrelated field.
    await storage.updateMemoryFrontmatter(id, { accessCount: 1 });

    const raw = await readFile(factFilePath(storage, id), "utf-8");
    assert.ok(!/\nsources:/.test(raw), "no sources line when the field is absent");
    assert.ok(!/\nprovenance:/.test(raw), "no provenance line when the field is absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty sources array does not emit a sources line", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-empty-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with an empty sources array.");

    await storage.updateMemoryFrontmatter(id, { sources: [] });

    const raw = await readFile(factFilePath(storage, id), "utf-8");
    assert.ok(!/\nsources:/.test(raw), "empty sources array must not emit a line");
    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path validation drops invalid in-memory sources (review thread 4)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-writeval-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with mixed-validity sources.");

    // One valid entry + one missing sessionKey + one missing observedAt.
    await storage.updateMemoryFrontmatter(id, {
      sources: [
        { sessionKey: "s/1", observedAt: "2026-01-01T00:00:00Z", quote: "valid" },
        { observedAt: "2026-01-01T00:00:00Z", quote: "no sessionKey" } as ProvenanceSource,
        { sessionKey: "s/3", quote: "no observedAt" } as ProvenanceSource,
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "fact must survive the write");
    assert.ok(written!.frontmatter.sources, "sources must survive with valid entries");
    assert.equal(written!.frontmatter.sources!.length, 1, "only the valid entry survives");
    assert.equal(written!.frontmatter.sources![0]!.quote, "valid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path drops source with invalid observedAt timestamp (review round 4)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-ts-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with bad timestamp.");

    await storage.updateMemoryFrontmatter(id, {
      sources: [
        { sessionKey: "s/1", observedAt: "not-a-date", quote: "bad ts" },
        { sessionKey: "s/2", observedAt: "2026-01-01T00:00:00Z", quote: "good" },
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources!.length, 1, "only the valid-timestamp entry survives");
    assert.equal(written!.frontmatter.sources![0]!.quote, "good");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path drops source with invalid span interval (review round 4)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-span-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with bad span.");

    await storage.updateMemoryFrontmatter(id, {
      sources: [
        { sessionKey: "s/1", observedAt: "2026-01-01T00:00:00Z", quote: "bad span", charStart: 10, charEnd: 5 },
        { sessionKey: "s/2", observedAt: "2026-01-01T00:00:00Z", quote: "good", charStart: 0, charEnd: 10 },
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources!.length, 1, "only the valid-span entry survives");
    assert.equal(written!.frontmatter.sources![0]!.quote, "good");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path downgrades provenance tag to none when all sources dropped (review round 4)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-downgrade-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with all-bad sources.");

    await storage.updateMemoryFrontmatter(id, {
      provenance: "verified",
      sources: [
        { sessionKey: "s/1", observedAt: "not-a-date", quote: "bad" },
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined, "all sources dropped");
    assert.equal(written!.frontmatter.provenance, "none", "tag downgraded from verified to none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path downgrades verified tag when sources field is absent (review round 5)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-absent-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact whose author set verified but supplied no sources.");

    // verified tag with NO sources field at all — the earlier 3-branch logic
    // kept the tag here (only all-invalid arrays downgraded).
    await storage.updateMemoryFrontmatter(id, { provenance: "verified" });

    const raw = await readFile(factFilePath(storage, id), "utf-8");
    assert.ok(!/\nsources:/.test(raw), "no sources line written");
    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined, "no sources present");
    assert.equal(
      written!.frontmatter.provenance,
      "none",
      "verified tag must downgrade to none without surviving sources",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path downgrades verified tag when sources array is empty (review round 5)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-emptytag-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with verified tag and an empty sources array.");

    // verified tag with sources: [] — fm.sources.length > 0 is false so the
    // earlier "all-invalid" branch never ran and the tag persisted.
    await storage.updateMemoryFrontmatter(id, { provenance: "verified", sources: [] });

    const raw = await readFile(factFilePath(storage, id), "utf-8");
    assert.ok(!/\nsources:/.test(raw), "empty sources array must not emit a line");
    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined);
    assert.equal(
      written!.frontmatter.provenance,
      "none",
      "verified tag must downgrade to none when sources array is empty",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-path downgrades hand-edited verified tag with no sources line (review round 5)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-handedited-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    // Synthesize a hand-edited / imported memory: provenance: verified with
    // no sources line at all. parseProvenanceTag and parseProvenanceSources
    // are independent, so without the read-path reconcile this would round-trip
    // as an ungrounded "verified" fact.
    const id = await writeFactFile(
      storage,
      "Hand-edited memory claiming verification it cannot back.",
      ["provenance: verified"],
    );

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined, "no sources line on disk");
    assert.equal(
      written!.frontmatter.provenance,
      "none",
      "read-path reconcile must downgrade verified to none without sources",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path drops source with non-integer character offsets (review round 6)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-intoffset-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with fractional span offsets.");

    await storage.updateMemoryFrontmatter(id, {
      sources: [
        { sessionKey: "s/1", observedAt: "2026-01-01T00:00:00Z", quote: "half", charStart: 2.5, charEnd: 8.5 },
        { sessionKey: "s/2", observedAt: "2026-01-01T00:00:00Z", quote: "whole", charStart: 0, charEnd: 9 },
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources!.length, 1, "fractional-offset entry dropped, integer entry kept");
    assert.equal(written!.frontmatter.sources![0]!.quote, "whole");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-path drops source with overflow-normalized ISO timestamp (review round 6)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-strictts-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact with calendar-overflow timestamp.");

    await storage.updateMemoryFrontmatter(id, {
      sources: [
        // 2026-02-30 silently normalizes to March 2 under Date.parse; the
        // strict ISO check must reject it. A bare "123" (year 123) is also
        // rejected by the format regex.
        { sessionKey: "s/1", observedAt: "2026-02-30T00:00:00Z", quote: "overflow" },
        { sessionKey: "s/2", observedAt: "123", quote: "bare-year" },
        { sessionKey: "s/3", observedAt: "2026-05-03T10:01:30Z", quote: "good" },
      ],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources!.length, 1, "overflow + bare-year dropped, valid ISO kept");
    assert.equal(written!.frontmatter.sources![0]!.quote, "good");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
