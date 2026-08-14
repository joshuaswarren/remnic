import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
            if (renameCalls === 4) throw new Error("publish failed");
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
            if (renameCalls === 4 || renameCalls === 5) throw new Error("rollback failed");
            await rename(source, destination);
          },
        }
      ),
      /Recovery files remain in/
    );
    const recoveryDir = (await readdir(outputDir)).find((name) => name.startsWith(".capture-"));
    assert.ok(recoveryDir);
    assert.equal(await readFile(path.join(outputDir, recoveryDir, ".previous", ASSETS[1]), "utf8"), `old-${ASSETS[1]}`);
    assert.equal(await readFile(path.join(outputDir, recoveryDir, ASSETS[1]), "utf8"), `new-${ASSETS[1]}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
