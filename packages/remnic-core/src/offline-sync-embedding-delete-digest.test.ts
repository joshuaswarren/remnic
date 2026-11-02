import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withEmbeddingGenerationLock } from "./embedding-generation-lock.js";
import { advanceEmbeddingGenerationMarker, embeddingGenerationMembership } from "./offline-sync-embedding-generation.js";

// Issue #3182 review: a peer can publish a newer shard while converge waits
// for the generation lock; the stale pre-lock digest must not delete it.
test("a stale-digest deletion is rejected under the generation lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-delete-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const relative = "state/embeddings/shard-0000.json";
  const target = path.join(root, relative);
  const marker = path.join(stateDir, "embeddings.generation");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "older shard");
  await writeFile(marker, "peer completed generation");
  const staleSha256 = createHash("sha256").update("older shard").digest("hex");

  let signalHeld: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  let releaseWriter: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
  assert.ok(releaseWriter);
  const writer = withEmbeddingGenerationLock(stateDir, async () => {
    signalHeld();
    await release;
    await writeFile(target, "newer peer shard");
  });
  await held;

  let validated = false;
  const deletion = advanceEmbeddingGenerationMarker(
    root,
    embeddingGenerationMembership(relative),
    async () => {
      assert.fail("deletion must never run when the digest is stale");
    },
    async () => {
      validated = true;
      if ((await readFile(target, "utf8")) !== "older shard") {
        throw new Error("converge file changed before deletion");
      }
    },
  );
  const rejected = assert.rejects(deletion, /changed before deletion/);
  releaseWriter();
  await writer;
  await rejected;

  assert.equal(validated, true, "the digest precondition must run inside the lock");
  assert.equal(await readFile(target, "utf8"), "newer peer shard");
  assert.equal(await readFile(marker, "utf8"), "peer completed generation");
});
