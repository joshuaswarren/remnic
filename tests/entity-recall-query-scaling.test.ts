/**
 * Entity recall must not re-normalize the query once per entity alias (COS-666).
 *
 * Profile of the live server (2026-11-15): buildEntityRecallSection held the main thread for 1.4 s per recall
 * (normalizeEntityText and scoreAliasMatch), because scoreAliasMatch(query, alias) normalized and tokenized the whole
 * query again for every alias of every entity. With N entities the cost is N x |query|.
 * All names are synthetic. Entity files are written directly: storage.writeEntity takes about 0.7 s per call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { parseConfig } from "@remnic/core/config";
import { buildEntityRecallSection } from "@remnic/core/entity-retrieval";
import { StorageManager } from "@remnic/core/storage";

const ENTITY_COUNT = Number(process.env.ENTITY_SCALE_COUNT ?? 1_500);
// Generous bound: the fixed code takes tens of ms; the old code scales with entities x query size.
const MAX_RECALL_MS = 1_500;

function entityName(n: number): string {
  let rest = n;
  let letters = "";
  do {
    letters = String.fromCharCode(97 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return `Vex${letters}qz`;
}

test("recall over many entities with a long query stays fast and still finds the named entity", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "entity-scale-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "entity-scale-workspace-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: false,
  });
  const storage = new StorageManager(memoryDir, config.entitySchemas);
  await storage.ensureDirectories();
  const entitiesDir = path.join(memoryDir, "entities");
  await mkdir(entitiesDir, { recursive: true });
  const stamp = "2026-11-15T00:00:00.000Z";
  await Promise.all(
    Array.from({ length: ENTITY_COUNT }, (_, n) => {
      const name = entityName(n);
      const body = `---\ncreated: ${stamp}\nupdated: ${stamp}\nsynthesis_updated_at: ""\nsynthesis_version: 0\ntype: Project\n---\n\n# ${name}\n\n**Type:** project\n**Updated:** ${stamp}\n\n## Synthesis\n\n\n## Timeline\n\n- [${stamp}] Synthetic fact about ${name}.\n`;
      return writeFile(path.join(entitiesDir, `project-${name.toLowerCase()}.md`), body);
    }),
  );
  const target = entityName(7);
  const filler = "the quick brown fox jumps over the lazy dog near the river bank ";
  const query = `Who is ${target}? ${filler.repeat(2_000)}`; // about 130 KB
  const options = {
    config,
    storage,
    recentTurns: 6,
    maxHints: 2,
    maxSupportingFacts: 3,
    maxRelatedEntities: 1,
    maxChars: 1_500,
    transcriptEntries: [],
  };
  await buildEntityRecallSection({ ...options, query: `Who is ${target}?` }); // builds the mention index; not timed
  const started = performance.now();
  const section = await buildEntityRecallSection({ ...options, query });
  const elapsedMs = performance.now() - started;

  assert.match(section ?? "", new RegExp(`\\b${target}\\b`), `the named entity is recalled; got: ${(section ?? "").slice(0, 300)}`);
  assert.ok(elapsedMs < MAX_RECALL_MS, `recall took ${Math.round(elapsedMs)} ms, limit ${MAX_RECALL_MS} ms`);
});
