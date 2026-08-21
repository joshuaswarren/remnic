import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRelayUiReplayFromRecording } from "../generate-relay-ui-replay.js";
import { verifyRelayRecording } from "./recording.js";

interface CliOptions {
  recordingDir: string;
  check: boolean;
  writeUi: boolean;
}

function parseArgs(argv: string[], repoRoot: string): CliOptions {
  let recordingDir = path.join(repoRoot, "docs", "remnic-relay", "recordings", "gpt-5-6-checkout-recovery");
  let check = false;
  let writeUi = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--recording-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--recording-dir requires a directory");
      recordingDir = path.resolve(value);
      index += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--write-ui") {
      writeUi = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run relay:replay -- [--recording-dir <directory>] [--check] [--write-ui]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown Relay replay argument: ${arg}`);
    }
  }
  if (!check && !writeUi) check = true;
  return { recordingDir, check, writeUi };
}

async function writeAtomically(destination: string, contents: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const options = parseArgs(process.argv.slice(2), repoRoot);
  const recording = await verifyRelayRecording(options.recordingDir, repoRoot);
  const replay = await createRelayUiReplayFromRecording(options.recordingDir, repoRoot);
  const expected = `${JSON.stringify(replay, null, 2)}\n`;
  const outputPath = path.join(repoRoot, "admin-console", "public", "relay", "replay.json");
  if (options.writeUi) await writeAtomically(outputPath, expected);
  if (options.check) {
    const committed = await readFile(outputPath, "utf8").catch(() => "");
    if (committed !== expected) {
      throw new Error("Mission Control replay is stale; run relay:replay -- --write-ui");
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "verified",
      source: path.relative(repoRoot, options.recordingDir),
      recordingSha256: recording.rootSha256,
      model: recording.metadata.model,
      calls: recording.creditReceipt.run.calls,
      creditUnitsSpent: recording.creditReceipt.run.budgetUnits,
      externalCalls: 0,
      productionDataRead: false,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Relay replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
