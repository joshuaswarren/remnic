/**
 * `remnic location` binary command (issue #2047) — thin CLI entry mirroring
 * commands/meetings.ts. All parsing, validation, provider registration, and
 * rendering live in @remnic/core's shared runner (`location/surfaces.ts`) so
 * this CLI and every other surface never fork. No orchestrator is booted:
 * location sync needs only the parsed config + memory dir; tag backfill
 * (#2046) constructs the default-namespace storage on demand.
 */

import fs from "node:fs";
import { parseConfig, resolveRemnicConfigRecord } from "@remnic/core";
import { backfillMemoryStorage, runLocationCliCommand } from "@remnic/core/location";
import { resolveConfigPath } from "../index.js";

export async function runLocationBinaryCommand(rest: string[]): Promise<void> {
  const locationArgs =
    rest.length === 0 || rest[0] === "--help" || rest[0] === "-h"
      ? ["help"]
      : rest;
  try {
    // Config failures get a constant message: parseConfig error strings can
    // embed config values (CodeQL js/clear-text-logging), so they must never
    // reach console output.
    let config: ReturnType<typeof parseConfig>;
    try {
      const configPath = resolveConfigPath();
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      config = parseConfig(resolveRemnicConfigRecord(raw));
    } catch {
      console.error(
        "location: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
      );
      process.exitCode = 1;
      return;
    }
    const code = await runLocationCliCommand(
      {
        config: config.location,
        memoryDir: config.memoryDir,
        getMemoryStorage: () => backfillMemoryStorage(config),
      },
      locationArgs,
      { stdout: process.stdout, stderr: process.stderr },
    );
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    // Runner errors are our own constructed messages (provider API error
    // classes, IO failures) — no config taint.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
