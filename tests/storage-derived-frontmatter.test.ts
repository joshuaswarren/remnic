/**
 * Storage round-trip tests for the consolidation provenance frontmatter
 * fields introduced in issue #561 PR 1:
 *
 *   - `derived_from?: string[]`  — `"<path>:<version>"` references into the
 *     page-versioning snapshots.
 *   - `derived_via?: "split" | "merge" | "update"` — which consolidation
 *     operator produced this memory.
 *
 * PR 1 only wires the frontmatter round-trip (preservation on read/write)
 * and the write-path validator.  No code emits these fields yet — that
 * lands in PR 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager round-trips derived_from and derived_via frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-derived-roundtrip";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-19T01:00:00.000Z",
      "updated: 2026-04-19T01:00:00.000Z",
      "source: test",
      "confidence: 0.9",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      'derived_from: ["facts/a.md:2", "facts/b.md:5"]',
      "derived_via: merge",
      "---",
      "",
      "merged payload",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory should be readable");
    assert.deepEqual(memory.frontmatter.derived_from, [
      "facts/a.md:2",
      "facts/b.md:5",
    ]);
    assert.equal(memory.frontmatter.derived_via, "merge");

    // Rewrite via archive — the serializer must emit the same fields.
    const archivedPath = await storage.archiveMemory(memory);
    assert.ok(archivedPath, "memory should archive");

    const archivedRaw = await readFile(archivedPath, "utf-8");
    assert.ok(
      archivedRaw.includes('derived_from: ["facts/a.md:2", "facts/b.md:5"]'),
      `archived file should contain derived_from line; got:\n${archivedRaw}`,
    );
    assert.ok(
      archivedRaw.includes("derived_via: merge"),
      `archived file should contain derived_via line; got:\n${archivedRaw}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager round-trips derived_from entries whose paths contain commas and quotes", async () => {
  // Quote-aware parser must not split on a comma embedded inside a path
  // component.  The escape policy for embedded double-quotes mirrors the
  // importanceReasons pipeline: `"` -> `\"` and `\` -> `\\`.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-commapath-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const pathyEntries = [
      "facts/a,b.md:2", // comma inside path
      'facts/weird "name".md:5', // quote inside path
      "facts/normal.md:0",
    ];
    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);
    const mutated = {
      ...memory,
      frontmatter: { ...memory.frontmatter, derived_from: pathyEntries },
    };
    await storage.moveMemoryToPath(mutated, targetPath);

    const reread = await storage.readAllMemories();
    const back = reread.find((m) => m.frontmatter.id === id);
    assert.ok(back);
    assert.deepEqual(back.frontmatter.derived_from, pathyEntries);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects a tier move from a stale caller snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-stale-move-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "payload", { source: "test" });
    const stale = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(stale);

    await storage.writeMemoryFrontmatter(stale, { tags: ["concurrent-update"] });
    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);

    await assert.rejects(
      () => storage.moveMemoryToPath(stale, targetPath),
      /changed before its tier move/,
    );
    const retained = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.deepEqual(retained?.frontmatter.tags, ["concurrent-update"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager accepts single-quoted and bare YAML derived_from entries from external editors", async () => {
  // External YAML emitters may produce any of: double-quoted (our
  // canonical form), single-quoted, or bare inline lists.  The parser
  // must preserve provenance regardless of which flavor arrives.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-yaml-flavors-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const flavors: Array<{ id: string; line: string; expected: string[] }> = [
      {
        id: "fact-derived-bare",
        line: "derived_from: [facts/a.md:2, facts/b.md:5]",
        expected: ["facts/a.md:2", "facts/b.md:5"],
      },
      {
        id: "fact-derived-single-quoted",
        line: "derived_from: ['facts/a.md:2', 'facts/b.md:5']",
        expected: ["facts/a.md:2", "facts/b.md:5"],
      },
      {
        id: "fact-derived-double-quoted",
        line: 'derived_from: ["facts/a.md:2", "facts/b.md:5"]',
        expected: ["facts/a.md:2", "facts/b.md:5"],
      },
      {
        // YAML single-quote escape: `''` is a literal `'` inside a
        // single-quoted scalar.  External YAML emitters do this for
        // paths containing apostrophes.
        id: "fact-derived-single-doubled-apos",
        line: "derived_from: ['facts/it''s.md:2', 'facts/b.md:5']",
        expected: ["facts/it's.md:2", "facts/b.md:5"],
      },
      {
        // YAML flow sequences may mix quoted + bare scalars.  Every entry
        // must survive, regardless of whether its neighbor was quoted.
        id: "fact-derived-mixed-quoted-bare",
        line: 'derived_from: ["facts/a.md:1", facts/b.md:2, \'facts/c.md:3\']',
        expected: ["facts/a.md:1", "facts/b.md:2", "facts/c.md:3"],
      },
      {
        // YAML block sequence: `key:` with an empty scalar followed by
        // indented `- item` lines.  Many external YAML emitters prefer
        // this style; the reader collapses it back to flow form before
        // tokenization.
        id: "fact-derived-block-sequence",
        line: "derived_from:\n  - facts/a.md:2\n  - facts/b.md:5",
        expected: ["facts/a.md:2", "facts/b.md:5"],
      },
      {
        // Block-sequence items may be quoted with YAML escape rules.
        // Single-quoted `'it''s'` decodes to `it's`; double-quoted
        // `"he said \"hi\""` decodes to `he said "hi"`.
        id: "fact-derived-block-escaped",
        line: "derived_from:\n  - 'facts/it''s.md:2'\n  - \"facts/b.md:5\"",
        expected: ["facts/it's.md:2", "facts/b.md:5"],
      },
    ];

    for (const flavor of flavors) {
      const raw = [
        "---",
        `id: ${flavor.id}`,
        "category: fact",
        "created: 2026-04-19T01:00:00.000Z",
        "updated: 2026-04-19T01:00:00.000Z",
        "source: test",
        "confidence: 0.8",
        "confidenceTier: implied",
        'tags: ["consolidation"]',
        flavor.line,
        "---",
        "",
        "yaml flavor payload",
        "",
      ].join("\n");
      await writeFile(path.join(factDir, `${flavor.id}.md`), raw, "utf-8");
    }

    const all = await storage.readAllMemories();
    for (const flavor of flavors) {
      const memory = all.find((m) => m.frontmatter.id === flavor.id);
      assert.ok(memory, `${flavor.id} should load`);
      assert.deepEqual(
        memory.frontmatter.derived_from,
        flavor.expected,
        `${flavor.id} should parse to ${JSON.stringify(flavor.expected)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager accepts quoted derived_via from external YAML emitters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-via-quoted-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const flavors: Array<{ id: string; line: string }> = [
      { id: "fact-via-bare", line: "derived_via: merge" },
      { id: "fact-via-double", line: 'derived_via: "merge"' },
      { id: "fact-via-single", line: "derived_via: 'merge'" },
    ];

    for (const flavor of flavors) {
      const raw = [
        "---",
        `id: ${flavor.id}`,
        "category: fact",
        "created: 2026-04-19T01:00:00.000Z",
        "updated: 2026-04-19T01:00:00.000Z",
        "source: test",
        "confidence: 0.8",
        "confidenceTier: implied",
        'tags: ["consolidation"]',
        flavor.line,
        "---",
        "",
        "payload",
        "",
      ].join("\n");
      await writeFile(path.join(factDir, `${flavor.id}.md`), raw, "utf-8");
    }

    const all = await storage.readAllMemories();
    for (const flavor of flavors) {
      const memory = all.find((m) => m.frontmatter.id === flavor.id);
      assert.ok(memory, `${flavor.id} should load`);
      assert.equal(
        memory.frontmatter.derived_via,
        "merge",
        `${flavor.id} should parse to "merge"`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager reads legacy memories without derived_from or derived_via", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "legacy payload", {
      source: "test",
    });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "legacy memory should load");
    assert.equal(memory.frontmatter.derived_from, undefined);
    assert.equal(memory.frontmatter.derived_via, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager supports all three ConsolidationOperator values on derived_via", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-ops-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const operators: Array<"split" | "merge" | "update"> = ["split", "merge", "update"];
    for (const op of operators) {
      const id = `fact-derived-${op}`;
      const filePath = path.join(factDir, `${id}.md`);
      const raw = [
        "---",
        `id: ${id}`,
        "category: fact",
        "created: 2026-04-19T01:00:00.000Z",
        "updated: 2026-04-19T01:00:00.000Z",
        "source: test",
        "confidence: 0.8",
        "confidenceTier: implied",
        'tags: ["consolidation"]',
        'derived_from: ["facts/source.md:1"]',
        `derived_via: ${op}`,
        "---",
        "",
        `${op} payload`,
        "",
      ].join("\n");
      await writeFile(filePath, raw, "utf-8");
    }

    const all = await storage.readAllMemories();
    for (const op of operators) {
      const memory = all.find((m) => m.frontmatter.id === `fact-derived-${op}`);
      assert.ok(memory, `memory for operator ${op} should load`);
      assert.equal(memory.frontmatter.derived_via, op);
      assert.deepEqual(memory.frontmatter.derived_from, ["facts/source.md:1"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects malformed derived_from on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "seed payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);

    // Each case is a distinct malformed `derived_from` value that the
    // serializer must reject.  Tests cover: missing version, non-numeric
    // version, empty string, and non-array shape.
    const badEntries: Array<unknown[]> = [
      ["facts/a.md"], // missing version
      ["facts/a.md:abc"], // non-numeric version
      [""], // empty entry
      ["facts/a.md:-1"], // negative version
    ];
    for (const bad of badEntries) {
      const mutated = {
        ...memory,
        frontmatter: { ...memory.frontmatter, derived_from: bad as string[] },
      };
      await assert.rejects(
        () => storage.moveMemoryToPath(mutated, targetPath),
        /invalid derived_from entry/,
        `should reject malformed derived_from ${JSON.stringify(bad)}`,
      );
    }

    // Non-array shape is rejected with a different error message.
    const nonArray = {
      ...memory,
      frontmatter: {
        ...memory.frontmatter,
        derived_from: "facts/a.md:2" as unknown as string[],
      },
    };
    await assert.rejects(
      () => storage.moveMemoryToPath(nonArray, targetPath),
      /derived_from must be an array/,
      "should reject non-array derived_from",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects unknown derived_via on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-via-unknown-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "seed payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);
    const mutated = {
      ...memory,
      frontmatter: {
        ...memory.frontmatter,
        derived_via: "annihilate" as unknown as "split" | "merge" | "update",
      },
    };

    await assert.rejects(
      () => storage.moveMemoryToPath(mutated, targetPath),
      /invalid derived_via/,
      "should reject unknown derived_via",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager tolerates unknown derived_via on read (drops to undefined)", async () => {
  // Read-path is intentionally permissive so future operator additions
  // don't brick a rollback to an older build.  Write-path rejects unknown
  // operators (covered in semantic-consolidation.test below).
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-unknown-op-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-derived-unknown";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-19T01:00:00.000Z",
      "updated: 2026-04-19T01:00:00.000Z",
      "source: test",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      "derived_via: annihilate",
      "---",
      "",
      "payload",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.derived_via, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
