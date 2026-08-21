import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureAssets } from "./capture-assets.mjs";

const ASSETS = ["owner.png", "helper.png"];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "what-helps-me-capture-test-"));
  const outputDir = path.join(root, "assets");
  await captureAssets(outputDir, ASSETS, async (stagingDir) => {
    for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `old-${assetName}`);
  });
  return { root, outputDir };
}

test("capture assets remain unchanged when the capture flow fails", async () => {
  const { root, outputDir } = await fixture();
  try {
    await assert.rejects(
      captureAssets(outputDir, ASSETS, async (stagingDir) => {
        await writeFile(path.join(stagingDir, ASSETS[0]), "partial-new-owner");
        throw new Error("capture failed");
      }),
      /capture failed/
    );
    for (const assetName of ASSETS) {
      assert.equal(await readFile(path.join(outputDir, assetName), "utf8"), `old-${assetName}`);
    }
    assert.deepEqual((await readdir(outputDir)).sort(), [...ASSETS].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture assets publish together after every staged file exists", async () => {
  const { root, outputDir } = await fixture();
  try {
    await captureAssets(outputDir, ASSETS, async (stagingDir) => {
      for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `new-${assetName}`);
    });
    for (const assetName of ASSETS) {
      assert.equal(await readFile(path.join(outputDir, assetName), "utf8"), `new-${assetName}`);
    }
    assert.deepEqual((await readdir(outputDir)).sort(), [...ASSETS].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture asset backups keep every published file in place until atomic replacement", async () => {
  const { root, outputDir } = await fixture();
  try {
    await captureAssets(
      outputDir,
      ASSETS,
      async (stagingDir) => {
        for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `new-${assetName}`);
      },
      {
        copyFile: async (source, destination) => {
          await copyFile(source, destination);
          assert.match(await readFile(source, "utf8"), /^old-/);
        },
        renameFile: async (source, destination) => {
          assert.match(await readFile(destination, "utf8"), /^old-/);
          await rename(source, destination);
        },
      }
    );
    for (const assetName of ASSETS) {
      assert.equal(await readFile(path.join(outputDir, assetName), "utf8"), `new-${assetName}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture asset publication rolls back an atomic replacement failure", async () => {
  const { root, outputDir } = await fixture();
  try {
    let renameCalls = 0;
    await assert.rejects(
      captureAssets(
        outputDir,
        ASSETS,
        async (stagingDir) => {
          for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `new-${assetName}`);
        },
        {
          renameFile: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 2) throw new Error("publish failed");
            await rename(source, destination);
          },
        }
      ),
      /publish failed/
    );
    for (const assetName of ASSETS) {
      assert.equal(await readFile(path.join(outputDir, assetName), "utf8"), `old-${assetName}`);
    }
    assert.deepEqual((await readdir(outputDir)).sort(), [...ASSETS].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture asset publication preserves recovery files when rollback fails", async () => {
  const { root, outputDir } = await fixture();
  try {
    let renameCalls = 0;
    await assert.rejects(
      captureAssets(
        outputDir,
        ASSETS,
        async (stagingDir) => {
          for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `new-${assetName}`);
        },
        {
          renameFile: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 2 || renameCalls === 3) throw new Error("rollback failed");
            await rename(source, destination);
          },
        }
      ),
      /Recovery files remain in/
    );
    const recoveryDir = (await readdir(outputDir)).find((name) => name.startsWith(".capture-"));
    assert.ok(recoveryDir);
    assert.equal(await readFile(path.join(outputDir, recoveryDir, ".previous", ASSETS[0]), "utf8"), `old-${ASSETS[0]}`);
    assert.equal(await readFile(path.join(outputDir, recoveryDir, ASSETS[1]), "utf8"), `new-${ASSETS[1]}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture asset publication defers interruption until rollback completes", async () => {
  const { root, outputDir } = await fixture();
  const signalSource = new EventEmitter();
  try {
    let renameCalls = 0;
    await assert.rejects(
      captureAssets(
        outputDir,
        ASSETS,
        async (stagingDir) => {
          for (const assetName of ASSETS) await writeFile(path.join(stagingDir, assetName), `new-${assetName}`);
        },
        {
          signalSource,
          renameFile: async (source, destination) => {
            renameCalls += 1;
            await rename(source, destination);
            if (renameCalls === 1) signalSource.emit("SIGTERM");
          },
        }
      ),
      /Capture publication interrupted by SIGTERM/
    );
    for (const assetName of ASSETS) {
      assert.equal(await readFile(path.join(outputDir, assetName), "utf8"), `old-${assetName}`);
    }
    assert.deepEqual((await readdir(outputDir)).sort(), [...ASSETS].sort());
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
