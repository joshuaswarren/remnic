import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

class CapturePublicationError extends AggregateError {
  preserveStaging = true;
}

class CaptureInterruptedError extends Error {}

async function publishAssets(outputDir, stagingDir, assetNames, renameFile, copyAsset, throwIfInterrupted) {
  const backupDir = path.join(stagingDir, ".previous");
  await mkdir(backupDir);
  throwIfInterrupted();
  const existing = [];
  for (const assetName of assetNames) {
    try {
      const destination = await lstat(path.join(outputDir, assetName));
      if (!destination.isFile()) throw new Error(`Existing capture asset is not a file: ${assetName}`);
      existing.push(assetName);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const published = [];
  try {
    for (const assetName of existing) {
      await copyAsset(path.join(outputDir, assetName), path.join(backupDir, assetName));
      throwIfInterrupted();
    }
    for (const assetName of assetNames) {
      await renameFile(path.join(stagingDir, assetName), path.join(outputDir, assetName));
      published.push(assetName);
      throwIfInterrupted();
    }
  } catch (publishError) {
    const rollbackErrors = [];
    for (const assetName of published.reverse()) {
      try {
        if (existing.includes(assetName)) {
          await renameFile(path.join(backupDir, assetName), path.join(outputDir, assetName));
        } else {
          await rm(path.join(outputDir, assetName), { force: true });
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new CapturePublicationError(
        [publishError, ...rollbackErrors],
        `Capture publication failed. Recovery files remain in ${stagingDir}`
      );
    }
    throw publishError;
  }
}

export async function captureAssets(outputDir, assetNames, runCapture, operations = {}) {
  for (const assetName of assetNames) {
    if (path.basename(assetName) !== assetName) throw new Error(`Invalid capture asset name: ${assetName}`);
  }
  if (new Set(assetNames).size !== assetNames.length) throw new Error("Capture asset names must be unique");
  const renameFile = operations.renameFile ?? rename;
  const copyAsset = operations.copyFile ?? copyFile;
  const signalSource = operations.signalSource ?? process;
  if (typeof renameFile !== "function") throw new Error("renameFile must be a function");
  if (typeof copyAsset !== "function") throw new Error("copyFile must be a function");
  if (typeof signalSource.on !== "function" || typeof signalSource.off !== "function") {
    throw new Error("signalSource must provide on and off functions");
  }
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(outputDir, ".capture-"));
  let removeStaging = true;
  try {
    await runCapture(stagingDir);
    for (const assetName of assetNames) {
      const staged = await lstat(path.join(stagingDir, assetName));
      if (!staged.isFile()) throw new Error(`Capture asset is not a file: ${assetName}`);
    }
    let interruptedSignal;
    const interrupt = (signal) => {
      interruptedSignal ??= signal;
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    const throwIfInterrupted = () => {
      if (interruptedSignal) throw new CaptureInterruptedError(`Capture publication interrupted by ${interruptedSignal}`);
    };
    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    try {
      throwIfInterrupted();
      await publishAssets(outputDir, stagingDir, assetNames, renameFile, copyAsset, throwIfInterrupted);
    } finally {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
    }
  } catch (error) {
    if (error instanceof CapturePublicationError) removeStaging = false;
    throw error;
  } finally {
    if (removeStaging) await rm(stagingDir, { recursive: true, force: true });
  }
}
