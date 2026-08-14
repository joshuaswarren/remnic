import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
