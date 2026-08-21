import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ExtractionResult } from "../src/types.js";

function longChunkCandidate(prefix: string): string {
  return Array.from(
    { length: 120 },
    (_, idx) => `${prefix} sentence ${idx + 1} adds deterministic chunking coverage.`,
  ).join(" ");
}

test("persistExtraction records proactive-pass facts with distinct extraction provenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-proactive-provenance-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: "Base extraction memory.",
        confidence: 0.9,
        tags: ["base"],
        source: "base",
      },
      {
        category: "fact",
        content: "Proactive extraction memory.",
        confidence: 0.92,
        tags: ["proactive"],
        source: "proactive",
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  const { persistedIds } = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(persistedIds.length, 2);

  const baseMemory = await storage.getMemoryById(persistedIds[0]);
  const proactiveMemory = await storage.getMemoryById(persistedIds[1]);

  assert.equal(baseMemory?.frontmatter.source, "extraction");
  assert.equal(proactiveMemory?.frontmatter.source, "extraction-proactive");
});

test("persistExtraction preserves base chunk source metadata while tagging proactive chunks distinctly", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-proactive-chunk-source-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: longChunkCandidate("Base chunk source"),
        confidence: 0.9,
        tags: ["base"],
        source: "base",
      },
      {
        category: "fact",
        content: longChunkCandidate("Proactive chunk source"),
        confidence: 0.92,
        tags: ["proactive"],
        source: "proactive",
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  const { persistedIds } = await orchestrator.persistExtraction(result, storage, null);
  const persistedMemories = await Promise.all(persistedIds.map((id: string) => storage.getMemoryById(id)));
  const parentMemories = persistedMemories.filter(
    (memory): memory is NonNullable<typeof memory> =>
      !!memory && !memory.frontmatter.parentId && memory.frontmatter.tags.includes("chunked"),
  );

  const baseParent = parentMemories.find((memory) => memory.frontmatter.source === "extraction");
  const proactiveParent = parentMemories.find((memory) => memory.frontmatter.source === "extraction-proactive");
  assert.ok(baseParent);
  assert.ok(proactiveParent);

  const baseChunk = (await storage.getChunksForParent(baseParent.frontmatter.id))[0];
  const proactiveChunk = (await storage.getChunksForParent(proactiveParent.frontmatter.id))[0];

  assert.ok(baseChunk);
  assert.ok(proactiveChunk);
  assert.equal(baseChunk.frontmatter.source, "chunking");
  assert.equal(proactiveChunk.frontmatter.source, "chunking-proactive");
});

// ── NGnei/NHIdx (codex P2): the catalog WRITE TOUCH must record the KNOWN base
// namespace, not a guess decoded from the storage dir. A namespace literally named
// like a canonical token (e.g. `ns-616c706861`, the token of `alpha`) served from
// its legacy raw dir `namespaces/ns-616c706861` would decode back to `alpha`, so
// the write touch updated `alpha` while the real namespace got no lastWriteAt. We
// pass the resolved base namespace into persistExtraction and assert the catalog
// records the real (token-named) namespace.
test("persistExtraction records the catalog write under the real namespace, not a dir-decoded guess (NHIdx)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nhidx-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  // A namespace whose literal name is the canonical token of `alpha`. Pre-create
  // its LEGACY RAW dir `namespaces/ns-616c706861` (with a marker) so the router
  // serves THAT root — which is byte-identical to alpha's TOKENIZED dir, so
  // decoding the directory alone yields `alpha` (the ambiguity NHIdx resolves by
  // carrying the known base namespace).
  const tokenNamedNs = "ns-616c706861";
  await mkdir(path.join(memoryDir, "namespaces", tokenNamedNs, "facts"), { recursive: true });
  const storage = await orchestrator.storageRouter.storageFor(tokenNamedNs);
  await storage.ensureDirectories();
  // Confirm the router serves the ambiguous legacy raw root (the bug precondition).
  assert.ok(
    storage.dir.endsWith(path.join("namespaces", tokenNamedNs)),
    "the token-named namespace must be served from its legacy raw root for this test",
  );

  const result: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: "Memory written to a token-named namespace.",
        confidence: 0.9,
        tags: ["nhidx"],
        source: "base",
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  // Pass the KNOWN base namespace (as runExtraction does via selfNamespace).
  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null, undefined, tokenNamedNs);
  assert.equal(ids.length, 1, "the fact is persisted");

  // Give the best-effort async catalog write a tick to settle.
  await new Promise((r) => setTimeout(r, 50));

  // The catalog must record the REAL token-named namespace with a write touch...
  const real = await orchestrator.namespaceCatalog.getNamespaceRecord(tokenNamedNs);
  assert.ok(real, "the real token-named namespace is catalogued");
  assert.ok(real.lastWriteAt, "the write touch is recorded under the real namespace");

  // ...and must NOT have recorded the write under the dir-decoded `alpha`.
  const decodedGuess = await orchestrator.namespaceCatalog.getNamespaceRecord("alpha");
  assert.ok(
    !decodedGuess || !decodedGuess.lastWriteAt,
    "the write touch must not be misattributed to the dir-decoded namespace",
  );
});

// ── NHZEZ (codex P2): an extraction that persists ONLY entities/relationships (no
// facts) still writes durable data to the base namespace, so the catalog must get a
// write touch — otherwise that namespace's lastWriteAt stays stale and
// writtenSince/QMD maintenance miss the write. The per-fact storage chokepoint never
// fires for a fact-less extraction; the new base-namespace touch covers it.
test("persistExtraction touches the catalog for an entity-only (fact-less) extraction (NHZEZ)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nhzez-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const ns = "project-origin-entityonly";
  const storage = await orchestrator.storageRouter.storageFor(ns);
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [], // NO facts — only an entity
    entities: [
      { name: "Acme Corp", type: "company", facts: ["Founded 2020."] },
    ],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null, undefined, ns);
  assert.ok(ids.length >= 0, "entity-only extraction completes");
  await new Promise((r) => setTimeout(r, 50));

  const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
  assert.ok(record, "the base namespace is catalogued for an entity-only extraction");
  assert.ok(
    record.lastWriteAt,
    "an entity-only extraction must record a catalog write touch (lastWriteAt)",
  );
});

// ── NHZEZ sweep (codex P2): the durable-non-fact catalog touch must also cover an
// extraction that persists ONLY profile updates (no facts, no entities). Profile
// updates are written via storage.appendToProfile() to the base namespace, after
// the entity/relationship loop, so the consolidated post-write touch must include
// them or a profile-only extraction leaves lastWriteAt stale.
test("persistExtraction touches the catalog for a profile-only (fact-less) extraction (NHZEZ sweep)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nhzez-profile-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const ns = "project-origin-profileonly";
  const storage = await orchestrator.storageRouter.storageFor(ns);
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: ["Prefers async-first design."], // ONLY a profile update
  };

  await orchestrator.persistExtraction(result, storage, null, undefined, ns);
  await new Promise((r) => setTimeout(r, 50));

  const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
  assert.ok(record, "the base namespace is catalogued for a profile-only extraction");
  assert.ok(
    record.lastWriteAt,
    "a profile-only extraction must record a catalog write touch (lastWriteAt)",
  );
});

// ── NHZEZ sweep (codex P2): the durable-non-fact catalog touch must also cover an
// extraction that persists ONLY questions (no facts, entities, or profile updates).
// Questions are written via storage.writeQuestion() to the base namespace.
test("persistExtraction touches the catalog for a question-only (fact-less) extraction (NHZEZ sweep)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-nhzez-question-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const ns = "project-origin-questiononly";
  const storage = await orchestrator.storageRouter.storageFor(ns);
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [],
    entities: [],
    relationships: [],
    questions: [
      { question: "What database does the project use?", context: "infra", priority: 0.5 },
    ],
    profileUpdates: [],
  };

  await orchestrator.persistExtraction(result, storage, null, undefined, ns);
  await new Promise((r) => setTimeout(r, 50));

  const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
  assert.ok(record, "the base namespace is catalogued for a question-only extraction");
  assert.ok(
    record.lastWriteAt,
    "a question-only extraction must record a catalog write touch (lastWriteAt)",
  );
});

// ── NIIly (codex P2): an extraction that persists ONLY an identity reflection (no
// facts, entities, profile updates, or questions) still writes durable
// namespace-local state via appendIdentityReflection(). The durable-non-fact
// catalog touch must therefore include identity reflection writes — otherwise an
// identity-only extraction leaves lastWriteAt stale.
test("persistExtraction touches the catalog for an identity-reflection-only extraction (NIIly)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-niily-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    identityEnabled: true,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const ns = "project-origin-identityonly";
  const storage = await orchestrator.storageRouter.storageFor(ns);
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
    identityReflection: "I tend to ask clarifying questions before committing.",
  };

  await orchestrator.persistExtraction(result, storage, null, undefined, ns);
  await new Promise((r) => setTimeout(r, 50));

  const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
  assert.ok(record, "the base namespace is catalogued for an identity-only extraction");
  assert.ok(
    record.lastWriteAt,
    "an identity-reflection-only extraction must record a catalog write touch (lastWriteAt)",
  );
});
