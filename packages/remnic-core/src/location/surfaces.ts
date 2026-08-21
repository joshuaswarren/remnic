/**
 * Location surface runners (issues #2047, #2046) — ONE implementation shared
 * by the CLI (`remnic location ...`), the MCP tools, the HTTP routes, and the
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
import { backfillLocationTags, type LocationBackfillReport } from "./backfill.js";
import type { LocationSourceSyncResult } from "./pipeline.js";
import { ensureConfiguredLocationProviders } from "./provider-setup.js";
import { parseLocationDaySummary, readLocationDay } from "./store.js";
import type { LocationConfig } from "./types.js";
import type { StorageManager } from "../index.js";

export interface LocationSurfaceDeps {
  config: LocationConfig;
  memoryDir: string;
  /**
   * Memory storage for tag backfill (default-namespace store). Optional so
   * pure day-sync surfaces (status/check/day) never construct one; hosts
   * that expose backfill provide it (issue #2046).
   */
  getMemoryStorage?: () => Promise<StorageManager>;
}

export async function runLocationStatus(
  deps: LocationSurfaceDeps,
): Promise<LocationStatusReport> {
  await ensureConfiguredLocationProviders(deps.config);
  return locationStatus(deps.config, deps.memoryDir);
}

export interface LocationSyncRun {
  date: string;
  results: LocationSourceSyncResult[];
}

export type LocationSyncRuns = LocationSyncRun[];
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
): { from: string; endDate: string; days: number } {
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
  return { from, endDate: to, days };
}

export interface LocationBackfillResult {
  /** Per-day provider sync results (empty under `dryRun`). */
  days: LocationSyncRuns;
  /** Memory re-tag report; absent when no memory storage was provided. */
  memory?: LocationBackfillReport;
}

/**
 * Backfill an explicit historical range (issue #2046): sync the days (unless
 * `dryRun`, which persists NOTHING — not day files, not memory patches), then
 * re-run the shared tagging core over the stored segments. Requires
 * `location.enabled` + `location.tagging.enabled` +
 * `location.tagging.backfillEnabled`.
 */
export async function runLocationBackfill(
  deps: LocationSurfaceDeps,
  request: { from?: unknown; to?: unknown; dryRun?: boolean } = {},
): Promise<LocationBackfillResult> {
  const range = parseLocationBackfillRange(request.from, request.to);
  if (!deps.config.enabled || !deps.config.tagging.enabled || !deps.config.tagging.backfillEnabled) {
    throw new EngramAccessInputError(
      "location: backfill requires location.enabled, location.tagging.enabled, and location.tagging.backfillEnabled",
    );
  }
  await ensureConfiguredLocationProviders(deps.config);
  const days =
    request.dryRun === true ? [] : (await syncLocation({ ...deps, endDate: range.endDate, days: range.days })) as LocationSyncRuns;
  let memory: LocationBackfillReport | undefined;
  if (deps.getMemoryStorage !== undefined) {
    memory = await backfillLocationTags({
      storage: await deps.getMemoryStorage(),
      memoryDir: deps.memoryDir,
      config: deps.config,
      from: range.from,
      to: range.endDate,
      dryRun: request.dryRun === true,
    });
  }
  return { days, ...(memory !== undefined ? { memory } : {}) };
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
  backfill --from <date> --to <date> [--dry-run]
                                 Sync an explicit historical range (≤ 90 days)
                                 and re-tag overlapping memories (requires
                                 location.tagging.backfillEnabled). --dry-run
                                 persists nothing: it only reports the memory
                                 changes stored segments would produce.
  day <YYYY-MM-DD>               Print one stored location day

Add --json to status/sync/backfill/day for machine-readable output.
Credentials for built-in providers come from the environment:
  reitti: REITTI_BASE_URL, REITTI_TOKEN[, REITTI_AUTH_MODE=x-api-token|bearer]
`;

const VALUE_FLAGS = new Set(["--date", "--days", "--from", "--to"]);
const BOOLEAN_FLAGS = new Set(["--json", "--dry-run"]);

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

function renderBackfillReport(io: LocationCliIo, report: LocationBackfillReport): void {
  for (const day of report.days) {
    if (day.emptyDay) {
      io.stdout.write(`${day.date}: no stored location observations (empty day)\n`);
      continue;
    }
    if (day.failed !== undefined) {
      io.stdout.write(`${day.date}: FAILED — ${day.failed}\n`);
      continue;
    }
    const c = day.counts;
    io.stdout.write(
      `${day.date}: ${c.tagged} tagged, ${c.updated} updated, ${c.removed} removed, ` +
        `${c.unchanged} unchanged, ${c.unmatched} unmatched (incl. ambiguous), ` +
        `${c.manual} manual, ${c.untimed} untimed, ${c.failed} failed, ` +
        `${day.considered} considered${report.dryRun ? " (dry run)" : ""}\n`,
    );
  }
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
        const result = await runLocationBackfill(deps, {
          from: flagString(parsed, "--from"),
          to: flagString(parsed, "--to"),
          dryRun: parsed.flags.has("--dry-run"),
        });
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          renderRuns(io, result.days);
          if (result.memory !== undefined) renderBackfillReport(io, result.memory);
        }
        const memoryFailed = result.memory?.days.some((day) => day.failed !== undefined) === true;
        return anySourceFailed(result.days) || memoryFailed ? 1 : 0;
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
