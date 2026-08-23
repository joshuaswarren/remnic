import fs from "node:fs";
import { type ExternalWikiRoot, parseConfig, resolveRemnicConfigRecord, runExternalWikiCliCommand } from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

export async function runExternalWikiBinaryCommand(rest: string[]): Promise<void> {
  let roots: readonly ExternalWikiRoot[];
  try {
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    roots = parseConfig(resolveRemnicConfigRecord(raw)).externalWikis;
  } catch {
    console.error(
      "external-wiki: failed to load the Remnic config - run `remnic doctor` and check the config file for errors"
    );
    process.exitCode = 1;
    return;
  }

  try {
    const code = await runExternalWikiCliCommand(roots, rest, {
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (code !== 0) process.exitCode = code;
  } catch {
    console.error("external-wiki: search failed");
    process.exitCode = 1;
  }
}
