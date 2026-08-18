/**
 * Location surface runners (issue #2047) — ONE implementation shared by the
 * CLI (`remnic location ...`), the MCP tools, the HTTP routes, and the
 * scheduler, so no surface can fork validation or disabled/empty/failure
 * semantics (same rule as the wearables runner). Parsing here is strict:
 * unknown flags reject with the valid list, invalid values reject loudly.
 */

import { EngramAccessInputError } from "../access-errors.js";
import {
  checkLocationSources,
  locationStatus,
  syncLocation,
  type LocationSourceCheckResult,
  type LocationStatusReport,
} from "./cli.js";
import { isValidLocationDate } from "./intervals.js";
import type { LocationSourceSyncResult } from "./pipeline.js";
import { ensureConfiguredLocationProviders } from "./provider-setup.js";
import { parseLocationDaySummary, readLocationDay } from "./store.js";
import type { LocationConfig } from "./types.js";

export interface LocationSurfaceDeps {
  config: LocationConfig;
  memoryDir: string;
}

export interface LocationSyncRun {
  date: string;
  results: LocationSourceSyncResult[];
}

export type LocationSyncRuns = LocationSyncRun[];

export async function runLocationStatus(
  deps: LocationSurfaceDeps,
): Promise<LocationStatusReport> {
  await ensureConfiguredLocationProviders(deps.config);
  return locationStatus(deps.config, deps.memoryDir);
}

export async function runLocationCheck(
  deps: LocationSurfaceDeps,
  signal?: AbortSignal,
): Promise<LocationSourceCheckResult[]> {
  await ensureConfiguredLocationProviders(deps.config);
  return checkLocationSources(deps.config, signal !== undefined ? { signal } : {});
}

export async function runLocationSync(
  deps: LocationSurfaceDeps,
  request: { endDate?: string; days?: number } = {},
): Promise<LocationSyncRuns> {
  await ensureConfiguredLocationProviders(deps.config);
  const runs = await syncLocation({ ...deps, ...validatedSyncWindow(request) });
  return runs as LocationSyncRuns;
}

export interface LocationDayView {
  date: string;
  found: boolean;
  sources: string[];
  observationCount: number;
  body: string | null;
}

export async function runLocationDay(memoryDir: string, rawDate: unknown): Promise<LocationDayView> {
  const date = requireLocationDate(rawDate, "date");
  const body = await readLocationDay(memoryDir, date);
  const summary = body === null ? null : parseLocationDaySummary(body);
  return {
    date,
    found: body !== null,
    sources: summary?.sources ?? [],
    observationCount: summary?.observationCount ?? 0,
    body,
  };
}

// ---------------------------------------------------------------------------
// Shared validation (CLI, MCP, HTTP all reject identically)
// ---------------------------------------------------------------------------

function requireLocationDate(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !isValidLocationDate(raw)) {
    throw new EngramAccessInputError(`location: ${label} is required (YYYY-MM-DD)`);
  }
  return raw;
}

function optionalLocationDays(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
    throw new EngramAccessInputError("location: days expects an integer from 1 to 90");
  }
  return parsed;
}

function validatedSyncWindow(request: { endDate?: string; days?: number }): {
  endDate?: string;
  days?: number;
} {
  const days = optionalLocationDays(request.days);
  const endDate =
    request.endDate === undefined || request.endDate === null || request.endDate === ""
      ? undefined
      : requireLocationDate(request.endDate, "date");
  return { ...(endDate !== undefined ? { endDate } : {}), ...(days !== undefined ? { days } : {}) };
}

/** Day span between two inclusive local dates (from ≤ to, ≤ 90 days). */
export function parseLocationBackfillRange(
  rawFrom: unknown,
  rawTo: unknown,
): { endDate: string; days: number } {
  const from = requireLocationDate(rawFrom, "from");
  const to = requireLocationDate(rawTo, "to");
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (toMs < fromMs) {
    throw new EngramAccessInputError("location: backfill --from must not be after --to");
  }
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (days > 90) {
    throw new EngramAccessInputError("location: backfill range is capped at 90 days");
  }
  return { endDate: to, days };
}

// ---------------------------------------------------------------------------
// CLI command (shared by every CLI host)
// ---------------------------------------------------------------------------

export interface LocationCliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

const USAGE = `Usage: location <command> [options]

Commands:
  status                         Configured sources, registration, last sync
  check                          Probe every enabled provider (auth/connectivity)
  sync [options]                 Sync recent local days (default: config.syncDays
                                   ending yesterday)
    --date <YYYY-MM-DD>          End the window on this day (inclusive)
    --days <n>                   Window size, 1..90 (default: location.syncDays)
  backfill --from <date> --to <date>
                                 Sync an explicit historical range (≤ 90 days)
  day <YYYY-MM-DD>               Print one stored location day

Add --json to status/sync/backfill/day for machine-readable output.
Credentials for built-in providers come from the environment:
  reitti: REITTI_BASE_URL, REITTI_TOKEN[, REITTI_AUTH_MODE=x-api-token|bearer]
`;

const VALUE_FLAGS = new Set(["--date", "--days", "--from", "--to"]);
const BOOLEAN_FLAGS = new Set(["--json"]);

interface ParsedCliFlags {
  flags: Map<string, string | true>;
  positional: string[];
}

function parseCliFlags(args: string[]): ParsedCliFlags {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new EngramAccessInputError(`location: ${arg} requires a value`);
      }
      flags.set(arg, value);
      index++;
      continue;
    }
    throw new EngramAccessInputError(
      `location: unknown flag '${arg}' — valid flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].join(", ")}`,
    );
  }
  return { flags, positional };
}

function flagString(parsed: ParsedCliFlags, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function renderStatus(report: LocationStatusReport): string {
  const lines = [
    `Location: ${report.enabled ? "enabled" : "disabled"} (timezone ${report.timezone})`,
  ];
  if (report.sources.length === 0) {
    lines.push("No sources configured. Add location.sources to the plugin config.");
    return `${lines.join("\n")}\n`;
  }
  for (const source of report.sources) {
    lines.push(
      `  ${source.id}: ${source.enabled ? "enabled" : "disabled"}, ` +
        `provider ${source.providerRegistered ? "registered" : "not registered"}, ` +
        `${source.trackedDays} tracked day${source.trackedDays === 1 ? "" : "s"}, ` +
        `last sync ${source.lastSyncedAtUtc ?? "never"}`,
    );
  }
  if (report.recentDays.length > 0) {
    lines.push("  recent days:");
    for (const day of report.recentDays) {
      lines.push(
        `    ${day.date}  ${day.observationCount} observation${day.observationCount === 1 ? "" : "s"}  [${day.sources.join(", ")}]`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function anySourceFailed(runs: LocationSyncRuns): boolean {
  return runs.some((run) => run.results.some((result) => result.status === "failed"));
}

function renderRuns(io: LocationCliIo, runs: LocationSyncRuns): void {
  for (const run of runs) {
    for (const result of run.results) {
      io.stdout.write(
        `${run.date} ${result.sourceId}: ${result.status}${result.error ? ` — ${result.error}` : ""} (${result.fetched} fetched)\n`,
      );
    }
  }
}

/** Run a `remnic location ...` command; returns a process exit code. */
export async function runLocationCliCommand(
  deps: LocationSurfaceDeps,
  args: string[],
  io: LocationCliIo,
): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help": {
        io.stdout.write(USAGE);
        return command === undefined ? 1 : 0;
      }
      case "status": {
        const parsed = parseCliFlags(rest);
        const report = await runLocationStatus(deps);
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return 0;
        }
        io.stdout.write(renderStatus(report));
        return 0;
      }
      case "check": {
        const results = await runLocationCheck(deps);
        for (const result of results) {
          const skipped = result.skipped === undefined ? "" : ` (skipped: ${result.skipped})`;
          io.stdout.write(
            `${result.id}: ${result.ok ? "OK" : "FAILED"}${skipped}${result.detail ? ` — ${result.detail}` : ""}\n`,
          );
        }
        return results.every((result) => result.ok) ? 0 : 1;
      }
      case "sync": {
        const parsed = parseCliFlags(rest);
        if (parsed.positional.length > 0) {
          throw new EngramAccessInputError(
            `location: unexpected argument '${parsed.positional[0]}' — sync takes flags only`,
          );
        }
        const daysValue = flagString(parsed, "--days");
        const runs = await runLocationSync(deps, {
          endDate: flagString(parsed, "--date"),
          ...(daysValue !== undefined ? { days: Number(daysValue) } : {}),
        });
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify({ days: runs }, null, 2)}\n`);
        } else {
          renderRuns(io, runs);
        }
        return anySourceFailed(runs) ? 1 : 0;
      }
      case "backfill": {
        const parsed = parseCliFlags(rest);
        const range = parseLocationBackfillRange(flagString(parsed, "--from"), flagString(parsed, "--to"));
        const runs = await runLocationSync(deps, range);
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify({ days: runs }, null, 2)}\n`);
        } else {
          renderRuns(io, runs);
        }
        return anySourceFailed(runs) ? 1 : 0;
      }
      case "day": {
        const parsed = parseCliFlags(rest);
        const date = parsed.positional[0] ?? flagString(parsed, "--date");
        const view = await runLocationDay(deps.memoryDir, date);
        if (!view.found) {
          io.stderr.write(`No stored location day for ${view.date}.\n`);
          return 1;
        }
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
          return 0;
        }
        io.stdout.write(`${view.body}\n`);
        return 0;
      }
      default:
        io.stderr.write(`location: unknown command '${command}'\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
