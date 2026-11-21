import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import { cleanupDir } from "./testing/orchestrator-lite.js";
import type { EntityFile } from "./types.js";

function entity(name: string, type: string): EntityFile {
  // SAFETY: buildKnowledgeIndex reads only these fields; the rest of the
  // entity shape is irrelevant to ordering.
  return { name, type, facts: [], relationships: [], summary: `${type} ${name}` } as unknown as EntityFile;
}

// Issue #3530 review: equal scores must not fall back to corpus order. Two
// entities can share a name across types, so the tie-break must use the
// full entity key (name and type), or a limited index picks a different
// entity after an equivalent rebuild that reads the corpus in another order.
test("equal-score entities that share a name order by type, not by corpus order (#3530)", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ki-order-"));
  t.after(() => cleanupDir(memoryDir));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  t.mock.method(StorageManager, "scoreEntity", () => 1);

  const pick = async (corpus: EntityFile[]) => {
    const storage = new StorageManager(memoryDir);
    t.mock.method(storage, "readAllEntityFiles", async () => corpus);
    return (await storage.buildKnowledgeIndex(config, { maxEntities: 1, maxChars: 10_000 })).result;
  };

  const forward = await pick([entity("Apple", "product"), entity("Apple", "company")]);
  const reversed = await pick([entity("Apple", "company"), entity("Apple", "product")]);

  assert.equal(forward, reversed, "the selected entity must not depend on corpus order");
});
