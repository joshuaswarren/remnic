import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmbeddingGenerationLockLostError, embeddingGenerationLockPath } from "./embedding-generation-lock.js";
import { advanceEmbeddingGenerationMarker, embeddingGenerationMembership } from "./offline-sync-embedding-generation.js";

// Lose ownership exactly after the in-flight rename, before any content write.
test("a direct embedding mutation rechecks ownership after its in-flight marker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-embedding-fence-"));
  const stateDir = path.join(root, "state");
  const relative = "state/embeddings/shard-0000.json";
  const target = path.join(root, relative);
  const marker = path.join(stateDir, "embeddings.generation");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "winning generation");
  await fs.writeFile(marker, "completed generation");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
    await rename(source, destination);
    if (String(destination) === marker && await fs.readFile(marker, "utf8") === "in-flight") {
      await fs.unlink(embeddingGenerationLockPath(stateDir));
      await fs.writeFile(marker, "peer completed generation");
    }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let writes = 0;
  await assert.rejects(
    advanceEmbeddingGenerationMarker(root, embeddingGenerationMembership(relative), async () => {
      writes++;
      await fs.writeFile(target, "stale owner's generation");
    }),
    EmbeddingGenerationLockLostError,
  );
  assert.equal(writes, 0, "a lost owner must stop before touching generation bytes");
  assert.equal(await fs.readFile(target, "utf8"), "winning generation");
  assert.equal(await fs.readFile(marker, "utf8"), "peer completed generation");
});
