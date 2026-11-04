import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";

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
