#!/usr/bin/env node
/**
 * `remnic-x` — standalone CLI for the X connector.
 *
 *   remnic-x status [--config <path>] [--json]
 *   remnic-x sync   [--config <path>] [--json]
 *
 * The config file is JSON: either the `xConnector` block itself or a
 * document with an `xConnector` key. Default path: $REMNIC_X_CONFIG or
 * ~/.config/remnic/x-connector.json.
 */

import { readFile } from "node:fs/promises";
import { exit } from "node:process";

import { expandTildePath } from "@remnic/core";

import { type XConnectorConfig, parseXConnectorConfig } from "./config.js";
import { createFileSink } from "./file-sink.js";
import { getXStatus, runXSync } from "./sync.js";
import type { XStatusReport, XSyncReport } from "./types.js";

const USAGE = [
  "usage: remnic-x <status|sync> [--config <path>] [--json]",
  "",
  "  status   offline snapshot: sources, availability, spend vs cap",
  "  sync     run one sync cycle per configured source priority",
  "  --config path to the xConnector JSON (default: $REMNIC_X_CONFIG",
  "           or ~/.config/remnic/x-connector.json)",
  "  --json   machine-readable output",
].join("\n");

interface CliArgs {
  command: "status" | "sync";
  configPath: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  let command: "status" | "sync" | null = null;
  let configPath: string | null = null;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "status" || arg === "sync") {
      if (command !== null) return null;
      command = arg;
    } else if (arg === "--config") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0) return null;
      configPath = value;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      return null;
    }
  }
  if (command === null) return null;
  return {
    command,
    configPath: configPath ?? process.env.REMNIC_X_CONFIG ?? "~/.config/remnic/x-connector.json",
    json,
  };
}

async function loadConfig(configPath: string): Promise<XConnectorConfig> {
  const resolved = expandTildePath(configPath);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch {
    throw new Error(`config file not found: ${resolved} (pass --config or set REMNIC_X_CONFIG)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file ${resolved} is not valid JSON (${err instanceof Error ? err.name : "parse error"})`);
  }
  const block =
    typeof parsed === "object" && parsed !== null && "xConnector" in parsed && typeof parsed.xConnector === "object"
      ? parsed.xConnector
      : parsed;
  return parseXConnectorConfig(block);
}

function printHuman(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let config: XConnectorConfig;
  try {
    config = await loadConfig(args.configPath);
  } catch (err) {
    process.stderr.write(`remnic-x: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!config.enabled) {
    printHuman(args.json ? JSON.stringify({ enabled: false }) : "xConnector is disabled.");
    return 0;
  }
  if (args.command === "status") {
    const status = await getXStatus(config);
    printHuman(args.json ? JSON.stringify(status, null, 2) : renderStatus(status));
    return 0;
  }
  const report = await runXSync(config, {
    sink: createFileSink({ stateDir: config.stateDir, mode: config.memoryMode }),
  });
  printHuman(args.json ? JSON.stringify(report, null, 2) : renderReport(report));
  // Skips are expected degradation (credits, caps), not failures.
  return report.sinkFailures > 0 ? 1 : 0;
}

function renderStatus(status: XStatusReport): string {
  const lines = [
    `xConnector ${status.enabled ? "enabled" : "disabled"} · memoryMode=${status.memoryMode} · schedule=${status.syncSchedule}`,
    `seen records: ${status.seenCount} · spend ${status.monthKey}: $${status.monthSpendUsd.toFixed(2)} of $${status.monthlyCostCapUsd.toFixed(2)} cap`,
    `last sync: ${status.lastSyncAt ?? "never"}`,
    "sources (priority order):",
  ];
  for (const source of status.sources) {
    const flag = source.available ? "ok  " : "MISS";
    lines.push(
      `  ${source.priority}. [${flag}] ${source.sourceId} (${source.kind}) last=${source.lastSyncAt ?? "never"} new=${source.lastRecordsNew}${source.availabilityDetail !== undefined ? ` — ${source.availabilityDetail}` : ""}`
    );
  }
  return lines.join("\n");
}

function renderReport(report: XSyncReport): string {
  const lines = [
    `sync ${report.runId} · mode=${report.memoryMode} · suggested=${report.suggestionsSubmitted} stored=${report.memoriesStored} failures=${report.sinkFailures} · month spend $${report.monthSpendUsd.toFixed(2)}`,
  ];
  for (const source of report.sources) {
    const note =
      source.error !== undefined
        ? ` error=${source.error}`
        : source.skipped !== undefined
          ? ` skipped=${source.skipped.reason}${source.skipped.detail !== undefined ? ` (${source.skipped.detail})` : ""}`
          : "";
    lines.push(
      `  ${source.sourceId} (${source.kind}): new=${source.recordsNew} known=${source.recordsKnown} reads=${source.reads} pages=${source.pages}${note}`
    );
  }
  return lines.join("\n");
}

main().then((code) => exit(code));
