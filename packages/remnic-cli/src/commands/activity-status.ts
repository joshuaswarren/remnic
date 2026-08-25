/**
 * `remnic activity-status` (#2053 status slice).
 *
 * Prints the content-free activity health snapshot from `buildActivityHealth`:
 * gate state, retention policy, source revision, last analysis status, and
 * counts only — never observation/card content, prompts, or media.
 * Defaults match the charter: master off, 30-day retention, never analyzed.
 * No arguments prints the default snapshot; --help prints usage.
 */
import { buildActivityHealth } from "@remnic/core";
import { hasFlag, resolveFlag } from "../cli-args.js";

export interface ActivityStatusIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: ActivityStatusIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function activityStatusHelp(): string {
  return `Usage: remnic activity-status [--enabled <true|false>] [--retention-days <n>] [--observations <n>]
                 [--cards <n>] [--analysis <ok|failed|skipped|never>] [--source-revision <id>]

  Print the content-free activity health snapshot as one JSON line.
  Defaults: enabled=false, retention-days=30, observations=0, cards=0,
  analysis=never, source-revision=null.
`;
}

function parseBoolFlag(
  rest: string[],
  flag: string,
  fallback: boolean,
  io: ActivityStatusIo,
): boolean | undefined {
  const raw = resolveFlag(rest, flag);
  if (raw === undefined) {
    if (hasFlag(rest, flag)) {
      io.stderr(`activity-status: ${flag} requires true or false`);
      return undefined;
    }
    return fallback;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  io.stderr(`activity-status: ${flag} must be true or false`);
  return undefined;
}

function parseCountFlag(
  rest: string[],
  flag: string,
  field: string,
  fallback: number,
  io: ActivityStatusIo,
): number | undefined {
  const raw = resolveFlag(rest, flag);
  if (raw === undefined) {
    if (hasFlag(rest, flag)) {
      io.stderr(`activity-status: ${field} must be a non-negative integer`);
      return undefined;
    }
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    io.stderr(`activity-status: ${field} must be a non-negative integer`);
    return undefined;
  }
  return value;
}

export function runActivityStatusCommand(rest: string[], io: ActivityStatusIo = defaultIo): number {
  if (rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(activityStatusHelp().trimEnd());
    return 0;
  }

  const enabled = parseBoolFlag(rest, "--enabled", false, io);
  if (enabled === undefined) return 1;
  const retentionDays = parseCountFlag(rest, "--retention-days", "retentionDays", 30, io);
  if (retentionDays === undefined) return 1;
  const observationCount = parseCountFlag(rest, "--observations", "observationCount", 0, io);
  if (observationCount === undefined) return 1;
  const cardCount = parseCountFlag(rest, "--cards", "cardCount", 0, io);
  if (cardCount === undefined) return 1;

  const analysisRaw = resolveFlag(rest, "--analysis");
  if (hasFlag(rest, "--analysis") && analysisRaw === undefined) {
    io.stderr("activity-status: --analysis requires one of ok, failed, skipped, never");
    return 1;
  }
  if (analysisRaw !== undefined && !["ok", "failed", "skipped", "never"].includes(analysisRaw)) {
    io.stderr(
      `activity-status: unknown analysis status ${JSON.stringify(analysisRaw)}; expected one of: ok, failed, skipped, never`,
    );
    return 1;
  }

  const sourceRevision = resolveFlag(rest, "--source-revision");

  try {
    const snapshot = buildActivityHealth({
      enabled,
      retentionDays,
      sourceRevision,
      lastAnalysisStatus: analysisRaw ?? null,
      observationCount,
      cardCount,
    });
    io.stdout(JSON.stringify(snapshot));
    return 0;
  } catch (err) {
    io.stderr(`activity-status: ${(err as Error).message}`);
    return 1;
  }
}

export async function runActivityStatusBinaryCommand(rest: string[]): Promise<void> {
  const code = runActivityStatusCommand(rest);
  if (code !== 0) process.exitCode = code;
}
