/**
 * `remnic activity-privacy retain --captured --now --days` (#2053 CLI slice).
 *
 * Maps flags onto `shouldRetain`. Prints `retain=true|false`.
 * `--days 0` keeps forever. Negative days are rejected.
 * `--enabled false` is the master-off gate.
 */
import { parseFlexibleIsoTimestamp, shouldRetain } from "@remnic/core";
import { hasFlag, resolveFlag } from "../cli-args.js";

export interface ActivityPrivacyIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: ActivityPrivacyIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function activityPrivacyHelp(): string {
  return `Usage: remnic activity-privacy retain --captured <iso> --now <iso> --days <n> [--enabled <true|false>]

  retain  Print retain=true or retain=false. --days 0 keeps forever.
`;
}

function parseEnabled(rest: string[], io: ActivityPrivacyIo): boolean | undefined {
  const raw = resolveFlag(rest, "--enabled");
  if (raw === undefined) {
    if (hasFlag(rest, "--enabled")) {
      io.stderr("activity-privacy: --enabled requires true or false");
      return undefined;
    }
    return true;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  io.stderr("activity-privacy: --enabled must be true or false");
  return undefined;
}

export function runActivityPrivacyCommand(
  rest: string[],
  io: ActivityPrivacyIo = defaultIo,
): number {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(activityPrivacyHelp().trimEnd());
    return 0;
  }
  if (rest[0] !== "retain") {
    io.stderr(`activity-privacy: unknown action "${rest[0]}".`);
    io.stderr(activityPrivacyHelp().trimEnd());
    return 1;
  }

  const capturedRaw = resolveFlag(rest, "--captured");
  const nowRaw = resolveFlag(rest, "--now");
  const daysRaw = resolveFlag(rest, "--days");
  if (capturedRaw === undefined || nowRaw === undefined || daysRaw === undefined) {
    io.stderr("activity-privacy: retain requires --captured <iso>, --now <iso>, and --days <n>");
    return 1;
  }

  const capturedAtMs = parseFlexibleIsoTimestamp(capturedRaw);
  const nowMs = parseFlexibleIsoTimestamp(nowRaw);
  if (capturedAtMs === null || nowMs === null) {
    io.stderr("activity-privacy: --captured and --now must be ISO timestamps");
    return 1;
  }

  const days = Number(daysRaw);
  if (!Number.isInteger(days) || days < 0) {
    io.stderr("activity-privacy: --days must be a non-negative integer");
    return 1;
  }

  const enabled = parseEnabled(rest, io);
  if (enabled === undefined) return 1;

  io.stdout(`retain=${shouldRetain(capturedAtMs, nowMs, days, enabled)}`);
  return 0;
}

export async function runActivityPrivacyBinaryCommand(rest: string[]): Promise<void> {
  const code = runActivityPrivacyCommand(rest);
  if (code !== 0) process.exitCode = code;
}
