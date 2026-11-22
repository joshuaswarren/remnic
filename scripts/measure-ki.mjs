// Measure knowledge-index cold vs warm build on a real on-disk corpus (#3529).
// Usage: node measure-ki.mjs <repo-root>
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../packages/remnic-core/dist/config.js";
import { StorageManager } from "../packages/remnic-core/dist/storage.js";

const root = process.argv[2];
const memoryDir = await mkdtemp(path.join(os.tmpdir(), "ki-measure-memory-"));

// Real corpus: 2,000 entity files on disk, 3 facts each (real read path, no mocks).
await mkdir(path.join(memoryDir, "entities"), { recursive: true });
for (let i = 0; i < 2000; i++) {
  const name = `entity-${String(i).padStart(4, "0")}`;
  const body = [
    "---",
    `name: ${name}`,
    "type: project",
    "---",
    "",
    "- fact one for " + name + " with some words to make the file realistic",
    "- fact two for " + name + " mentioning a relationship to entity-0000",
    "- fact three for " + name + " padding the file so reads cost real I/O",
    "",
  ].join("\n");
  await writeFile(path.join(memoryDir, "entities", `${name}.md`), body);
}

const config = parseConfig({
  openaiApiKey: "sk-test",
  memoryDir,
  knowledgeIndexEnabled: true,
  knowledgeIndexMaxEntities: 50,
  knowledgeIndexMaxChars: 8000,
});
const storage = new StorageManager(memoryDir, config.entitySchemas);
await storage.ensureDirectories();

const LIMITS = { maxEntities: 50, maxChars: 8000 }; // recall's call shape

const t0 = performance.now();
const cold = await storage.buildKnowledgeIndex(config, LIMITS);
const coldMs = performance.now() - t0;

const t1 = performance.now();
const warm = await storage.buildKnowledgeIndex(config, LIMITS);
const warmMs = performance.now() - t1;

console.log(JSON.stringify({
  entities: 2000,
  coldMs: Math.round(coldMs * 100) / 100,
  coldCached: cold.cached,
  warmMs: Math.round(warmMs * 100) / 100,
  warmCached: warm.cached,
  rowsMatch: cold.result === warm.result,
}));

await rm(memoryDir, { recursive: true, force: true });
