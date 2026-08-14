import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function captureAssets(outputDir, assetNames, runCapture) {
  for (const assetName of assetNames) {
    if (path.basename(assetName) !== assetName) throw new Error(`Invalid capture asset name: ${assetName}`);
  }
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(outputDir, ".capture-"));
  try {
    await runCapture(stagingDir);
    for (const assetName of assetNames) {
      const staged = await stat(path.join(stagingDir, assetName));
      if (!staged.isFile()) throw new Error(`Capture asset is not a file: ${assetName}`);
    }
    for (const assetName of assetNames) {
      await copyFile(path.join(stagingDir, assetName), path.join(outputDir, assetName));
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
