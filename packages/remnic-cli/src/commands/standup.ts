import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord } from "@remnic/core";
import { resolveConfigPath } from "../index.js";
import { buildStandup, parseStandupDate, standupHelp } from "@remnic/core/standup";

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runStandupBinaryCommand(rest: string[]): Promise<void> {
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(standupHelp());
    return;
  }
  let orchestrator: Orchestrator | undefined;
  try {
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const config = parseConfig(resolveRemnicConfigRecord(raw));
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const brief = buildStandup(orchestrator.config.memoryDir, parseStandupDate(takeFlag(rest, "--date")));
    console.log(brief.markdown);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    orchestrator?.abortDeferredInit();
    await orchestrator?.destroy();
  }
}
