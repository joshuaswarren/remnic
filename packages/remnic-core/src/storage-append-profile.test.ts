import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";

async function makeStorage(): Promise<{ storage: StorageManager; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-append-"));
  return { storage: new StorageManager(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("concurrent appendToProfile bullets both survive the shared profile read-modify-write", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    // Hold the FIRST write open while the second append runs a full RMW. Under
    // a shared unlocked RMW both reads see the same (missing) profile and the
    // second write silently drops the first task's bullet.
    const realWrite = storage.writeProfile.bind(storage);
    const firstWriteEntered = Promise.withResolvers<void>();
    const firstWriteGate = Promise.withResolvers<void>();
    let writes = 0;
    // SAFETY: the test drives only readProfile/writeProfile on the real manager;
    // instance overrides keep the RMW interception local to this test.
    storage.writeProfile = async (content: string) => {
      writes += 1;
      if (writes === 1) {
        firstWriteEntered.resolve();
        await firstWriteGate.promise;
      }
      await realWrite(content);
    };

    const first = storage.appendToProfile(["bullet-a"]);
    await firstWriteEntered.promise;
    const second = storage.appendToProfile(["bullet-b"]);
    firstWriteGate.resolve();
    await Promise.all([first, second]);

    const profile = await storage.readProfile();
    assert.match(profile ?? "", /bullet-a/, "first task's bullet must survive");
    assert.match(profile ?? "", /bullet-b/, "second task's bullet must survive");
  } finally {
    await cleanup();
  }
});

test("appendToProfile fails closed when a cross-process peer holds profile.md.lock", async () => {
  const { storage, cleanup } = await makeStorage();
  const peer = new StorageManager(storage["baseDir"]);
  try {
    const holderEntered = Promise.withResolvers<void>();
    const holderRelease = Promise.withResolvers<void>();
    // Foreign holder (simulated external drain process) owns the lock file.
    const holder = withHeldFileLock(
      path.join(storage["baseDir"], "profile.md.lock"),
      { staleMs: 60_000 },
      async (acquired) => {
        assert.ok(acquired, "test holder must acquire the lock");
        holderEntered.resolve();
        await holderRelease.promise;
      },
    );
    await holderEntered.promise;

    // The peer must NOT fall back to an unlocked RMW: fail closed, file untouched.
    await assert.rejects(
      peer.appendToProfile(["lost bullet"]),
      /profile\.md\.lock not acquired/,
    );
    const before = await storage.readProfile();
    assert.doesNotMatch(before, /lost bullet/, "locked-out append must not write");

    holderRelease.resolve();
    await holder;

    // Once the peer releases, the append goes through normally.
    await peer.appendToProfile(["late bullet"]);
    const after = await storage.readProfile();
    assert.match(after, /late bullet/, "append after contention window must succeed");
  } finally {
    await cleanup();
  }
});

test("commitConsolidatedProfile commits unchanged baseline and conflicts on a stale one", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.appendToProfile(["trait one", "trait two"]);
    const baseline = await storage.readProfile();

    // Unchanged profile → commit takes the consolidated rewrite.
    const committed = await storage.commitConsolidatedProfile(
      baseline,
      "# Behavioral Profile\n\n- consolidated summary\n",
    );
    assert.equal(committed, "committed");
    assert.match(await storage.readProfile(), /consolidated summary/);

    // Stale baseline (profile moved on since the LLM saw it) → conflict, file untouched.
    await storage.appendToProfile(["fresh concurrent trait"]);
    const current = await storage.readProfile();
    const conflict = await storage.commitConsolidatedProfile(
      baseline,
      "# Behavioral Profile\n\n- older stale rewrite\n",
    );
    assert.equal(conflict, "conflict");
    assert.equal(await storage.readProfile(), current, "conflicting commit must not touch the file");
    assert.match(await storage.readProfile(), /fresh concurrent trait/);
  } finally {
    await cleanup();
  }
});
