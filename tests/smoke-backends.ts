/**
 * Smoke test: exercise each new backend locally.
 * Run with: npx tsx tests/smoke-backends.ts
 */
import path from "node:path";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";

const tmpBase = await mkdtemp(path.join(os.tmpdir(), "engram-smoke-"));
console.log(`Temp dir: ${tmpBase}`);

// Create fake memory files
const memoryDir = path.join(tmpBase, "memory");
const factsDir = path.join(memoryDir, "facts");
await mkdir(factsDir, { recursive: true });

for (let i = 1; i <= 5; i++) {
  await writeFile(
    path.join(factsDir, `fact-${i}.md`),
    `---\nid: fact-${i}\ncategory: fact\ncreated: 2026-03-02\nupdated: 2026-03-02\nsource: test\nconfidence: 0.9\ntags: []\n---\nThis is test fact number ${i} about ${["TypeScript", "Node.js", "Orama search", "LanceDB vectors", "Meilisearch hybrid"][i - 1]}.`,
  );
}

// Fake config (embedding disabled — FTS only)
const fakeConfig: any = {
  embeddingFallbackEnabled: false,
  embeddingFallbackProvider: "auto",
  openaiApiKey: undefined,
  localLlmEnabled: false,
  localLlmUrl: "",
  localLlmModel: "",
  localLlmAuthHeader: true,
  memoryDir,
};

// ── 1. Orama ──
console.log("\n=== Orama Backend ===");
try {
  const { OramaBackend } = await import("../src/search/orama-backend.js");
  const { EmbedHelper } = await import("../src/search/embed-helper.js");
  const embedHelper = new EmbedHelper(fakeConfig);
  const orama = new OramaBackend({
    dbPath: path.join(tmpBase, "orama"),
    collection: "test",
    embedHelper,
    memoryDir,
    embeddingDimension: 1536,
  });

  const probed = await orama.probe();
  console.log(`  probe: ${probed}`);
  console.log(`  status: ${orama.debugStatus()}`);

  await orama.update();
  console.log("  update: done");

  const results = await orama.bm25Search("TypeScript", undefined, 5);
  console.log(`  bm25Search("TypeScript"): ${results.length} results`);
  for (const r of results) {
    console.log(`    - ${r.docid} (score: ${r.score.toFixed(3)}) ${r.snippet.slice(0, 60)}`);
  }

  const global = await orama.searchGlobal("fact", 3);
  console.log(`  searchGlobal("fact"): ${global.length} results`);

  console.log("  ✅ Orama PASSED");
} catch (err) {
  console.error("  ❌ Orama FAILED:", err);
}

// ── 2. LanceDB ──
console.log("\n=== LanceDB Backend ===");
try {
  const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
  const { EmbedHelper } = await import("../src/search/embed-helper.js");
  const embedHelper = new EmbedHelper(fakeConfig);
  const lance = new LanceDbBackend({
    dbPath: path.join(tmpBase, "lancedb"),
    collection: "test",
    embedHelper,
    memoryDir,
    embeddingDimension: 4, // small dimension since no real embeddings
  });

  const probed = await lance.probe();
  console.log(`  probe: ${probed}`);
  console.log(`  status: ${lance.debugStatus()}`);

  await lance.update();
  console.log("  update: done");

  const results = await lance.bm25Search("TypeScript", undefined, 5);
  console.log(`  bm25Search("TypeScript"): ${results.length} results`);
  for (const r of results) {
    console.log(`    - ${r.docid} (score: ${r.score.toFixed(3)}) ${r.snippet.slice(0, 60)}`);
  }

  const global = await lance.searchGlobal("fact", 3);
  console.log(`  searchGlobal("fact"): ${global.length} results`);

  console.log("  ✅ LanceDB PASSED");
} catch (err) {
  console.error("  ❌ LanceDB FAILED:", err);
}

// ── 3. Meilisearch ──
console.log("\n=== Meilisearch Backend ===");
try {
  const { MeilisearchBackend } = await import("../src/search/meilisearch-backend.js");
  const meili = new MeilisearchBackend({
    host: "http://localhost:7700",
    collection: "engram-smoke-test",
    autoIndex: true,
    memoryDir,
  });

  const probed = await meili.probe();
  console.log(`  probe: ${probed}`);
  console.log(`  status: ${meili.debugStatus()}`);

  if (probed) {
    await meili.update();
    console.log("  update: done");

    // Meilisearch indexing is async — wait a moment
    await new Promise((r) => setTimeout(r, 2000));

    const results = await meili.bm25Search("TypeScript", undefined, 5);
    console.log(`  bm25Search("TypeScript"): ${results.length} results`);
    for (const r of results) {
      console.log(`    - ${r.docid} (score: ${r.score.toFixed(3)}) ${r.snippet.slice(0, 60)}`);
    }
    console.log("  ✅ Meilisearch PASSED");
  } else {
    console.log("  ⏭️  Meilisearch not running — skipped (run: docker run -p 7700:7700 getmeili/meilisearch)");
  }
} catch (err) {
  console.error("  ❌ Meilisearch FAILED:", err);
}

// Cleanup
await rm(tmpBase, { recursive: true, force: true });
console.log(`\nCleaned up ${tmpBase}`);
