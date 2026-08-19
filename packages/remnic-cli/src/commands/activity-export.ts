/**
 * `remnic activity-export --from --to --format json` (#2053 export slice).
 *
 * Half-open [from, to). Missing --from exits 1. --to omitted is now.
 * `--enabled false` denies (prints []). Does not persist.
 * Prints a JSON array of {id, capturedAt}.
 */
import { observationsForExport, parseActivityPrivacy, parseFlexibleIsoTimestamp } from "@remnic/core";
import { hasFlag, resolveFlag } from "../cli-args.js";

export interface ActivityExportIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface ActivityExportItem {
  id: string | number;
  capturedAt: string;
}

const defaultIo: ActivityExportIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function activityExportHelp(): string {
  return `Usage: remnic activity-export --from <iso> [--to <iso>] [--format json] [--enabled <true|false>]

  Print a JSON array of {id, capturedAt} in the half-open [from, to) window.
`;
}

function parseEnabled(rest: string[], io: ActivityExportIo): boolean | undefined {
  const raw = resolveFlag(rest, "--enabled");
  if (raw === undefined) {
    if (hasFlag(rest, "--enabled")) {
      io.stderr("activity-export: --enabled requires true or false");
      return undefined;
    }
    return true;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  io.stderr("activity-export: --enabled must be true or false");
  return undefined;
}

export function runActivityExportCommand(
  rest: string[],
  io: ActivityExportIo = defaultIo,
  items: readonly ActivityExportItem[] = [],
  nowMs: number = Date.now(),
): number {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(activityExportHelp().trimEnd());
    return 0;
  }

  const fromRaw = resolveFlag(rest, "--from");
  if (fromRaw === undefined) {
    io.stderr("activity-export: --from <iso> is required");
    return 1;
  }
  const fromMs = parseFlexibleIsoTimestamp(fromRaw);
  if (fromMs === null) {
    io.stderr("activity-export: --from must be an ISO timestamp");
    return 1;
  }

  const toRaw = resolveFlag(rest, "--to");
  let toMs: number;
  if (toRaw === undefined) {
    if (hasFlag(rest, "--to")) {
      io.stderr("activity-export: --to requires an ISO timestamp");
      return 1;
    }
    toMs = nowMs;
  } else {
    const parsed = parseFlexibleIsoTimestamp(toRaw);
    if (parsed === null) {
      io.stderr("activity-export: --to must be an ISO timestamp");
      return 1;
    }
    toMs = parsed;
  }

  const format = resolveFlag(rest, "--format");
  if (format === undefined) {
    if (hasFlag(rest, "--format")) {
      io.stderr("activity-export: --format requires json");
      return 1;
    }
  } else if (format !== "json") {
    io.stderr("activity-export: --format must be json");
    return 1;
  }

  const enabled = parseEnabled(rest, io);
  if (enabled === undefined) return 1;

  const policy = parseActivityPrivacy({ enabled, exportIncludeObservations: true });
  const exported = observationsForExport(items, policy)
    .filter((item) => {
      const at = parseFlexibleIsoTimestamp(item.capturedAt);
      return at !== null && at >= fromMs && at < toMs;
    })
    .map((item) => ({ id: item.id, capturedAt: item.capturedAt }));

  io.stdout(JSON.stringify(exported));
  return 0;
}

export async function runActivityExportBinaryCommand(rest: string[]): Promise<void> {
  const code = runActivityExportCommand(rest);
  if (code !== 0) process.exitCode = code;
}
