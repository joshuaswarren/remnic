/**
 * `remnic activity-privacy` (#2053 privacy-controls CLI).
 *
 * Actions:
 *   retain  Print retain=true|false for one capture (--days 0 keeps forever).
 *   delete  Dry-run retention plan over JSON-lines candidates on stdin.
 *           Master `--enabled false` refuses. Prints the plan; never deletes.
 *   redact  Drop listed keys from one JSON object on stdin.
 *   gates   Resolve the five activity feature gates under the master switch.
 */
import {
  ACTIVITY_DELETE_SCOPES,
  normalizeDropKeys,
  parseFlexibleIsoTimestamp,
  planActivityDeletion,
  redactActivityFields,
  resolveActivityGates,
  shouldRetain,
  type ActivityDeleteCandidate,
} from "@remnic/core";
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
  return `Usage: remnic activity-privacy <action> [options]

  retain  --captured <iso> --now <iso> --days <n> [--enabled <true|false>]
          Print retain=true or retain=false. --days 0 keeps forever.
  delete  --scope <name> [--scope <name>...] --now <iso> [--retention-days <n>] [--enabled <true|false>]
          Read {"scope","relPath","capturedAtMs"} JSON lines on stdin; print the
          deletion plan {"deletePaths","keptCount","refused"}. Dry-run only.
          Scopes: ${ACTIVITY_DELETE_SCOPES.join(", ")}.
  redact  --keys <comma,list>
          Read one JSON object on stdin; print it without the listed keys.
  gates   [--enabled <true|false>] [--analysis|--journal|--weekly|--export|--memory-creation <true|false>]
          Print the resolved gate set. Master off forces every gate off.
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

function flagValues(rest: string[], flag: string): { values: string[]; missingValue: boolean } {
  const values: string[] = [];
  let missingValue = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === flag) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        missingValue = true;
      } else {
        values.push(next);
      }
    }
  }
  return { values, missingValue };
}

export function runActivityDeleteCommand(
  rest: string[],
  candidateLines: readonly string[],
  io: ActivityPrivacyIo = defaultIo,
): number {
  const enabled = parseEnabled(rest, io);
  if (enabled === undefined) return 1;
  if (!enabled) {
    io.stderr("activity-privacy: activity is disabled; delete refused");
    return 1;
  }

  const { values: scopes, missingValue } = flagValues(rest, "--scope");
  if (missingValue) {
    io.stderr("activity-privacy: --scope requires a scope name");
    return 1;
  }
  if (scopes.length === 0) {
    io.stderr("activity-privacy: delete requires at least one --scope");
    return 1;
  }

  const nowRaw = resolveFlag(rest, "--now");
  if (nowRaw === undefined) {
    io.stderr("activity-privacy: delete requires --now <iso>");
    return 1;
  }
  const nowMs = parseFlexibleIsoTimestamp(nowRaw);
  if (nowMs === null) {
    io.stderr("activity-privacy: --now must be an ISO timestamp");
    return 1;
  }

  const daysRaw = resolveFlag(rest, "--retention-days");
  let retentionDays = 0;
  if (daysRaw !== undefined) {
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 0) {
      io.stderr("activity-privacy: --retention-days must be a non-negative integer");
      return 1;
    }
    retentionDays = days;
  }

  const candidates: ActivityDeleteCandidate[] = [];
  let lineNo = 0;
  for (const line of candidateLines) {
    lineNo += 1;
    const text = line.trim();
    if (text.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      io.stderr(`activity-privacy: candidate line ${lineNo} is not valid JSON`);
      return 1;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof record.scope !== "string" ||
      typeof record.relPath !== "string" ||
      typeof record.capturedAtMs !== "number" ||
      !Number.isFinite(record.capturedAtMs)
    ) {
      io.stderr(
        `activity-privacy: candidate line ${lineNo} must be {"scope": string, "relPath": string, "capturedAtMs": number}`,
      );
      return 1;
    }
    candidates.push({
      scope: record.scope,
      relPath: record.relPath,
      capturedAtMs: record.capturedAtMs,
    });
  }

  try {
    const plan = planActivityDeletion({ candidates, scopes, retentionDays, nowMs });
    io.stdout(JSON.stringify(plan));
    return 0;
  } catch (err) {
    io.stderr(`activity-privacy: ${(err as Error).message}`);
    return 1;
  }
}

export function runActivityRedactCommand(
  rest: string[],
  stdinLines: readonly string[],
  io: ActivityPrivacyIo = defaultIo,
): number {
  const keysRaw = resolveFlag(rest, "--keys");
  if (keysRaw === undefined) {
    io.stderr("activity-privacy: redact requires --keys <comma,list>");
    return 1;
  }
  const text = stdinLines.join("\n").trim();
  if (text.length === 0) {
    io.stderr("activity-privacy: redact requires one JSON object on stdin");
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    io.stderr("activity-privacy: redact input is not valid JSON");
    return 1;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    io.stderr("activity-privacy: redact input must be a JSON object");
    return 1;
  }
  const dropKeys = normalizeDropKeys(keysRaw.split(","));
  const redacted = redactActivityFields(parsed as Record<string, unknown>, { dropKeys });
  io.stdout(JSON.stringify(redacted));
  return 0;
}

const GATE_FLAGS: Readonly<Record<string, string>> = {
  "--analysis": "analysis",
  "--journal": "journal",
  "--weekly": "weekly",
  "--export": "export",
  "--memory-creation": "memoryCreation",
};

export function runActivityGatesCommand(rest: string[], io: ActivityPrivacyIo = defaultIo): number {
  const known = new Set(["--enabled", ...Object.keys(GATE_FLAGS)]);
  for (const token of rest) {
    if (token.startsWith("--") && !known.has(token)) {
      io.stderr(`activity-privacy: unknown gate flag ${token}`);
      return 1;
    }
  }

  type GateParse = { error: true } | { error: false; value?: boolean };

  const parseGateValue = (flag: string): GateParse => {
    if (!hasFlag(rest, flag)) return { error: false };
    const raw = resolveFlag(rest, flag);
    if (raw === undefined) {
      io.stderr(`activity-privacy: ${flag} requires true or false`);
      return { error: true };
    }
    if (raw === "true") return { error: false, value: true };
    if (raw === "false") return { error: false, value: false };
    io.stderr(`activity-privacy: ${flag} must be true or false`);
    return { error: true };
  };

  const enabledResult = parseGateValue("--enabled");
  if (enabledResult.error) return 1;
  const gates: Record<string, boolean> = {};
  for (const [flag, gate] of Object.entries(GATE_FLAGS)) {
    const result = parseGateValue(flag);
    if (result.error) return 1;
    if (result.value !== undefined) gates[gate] = result.value;
  }
  const enabled = enabledResult.value ?? false;

  try {
    const resolved = resolveActivityGates({ enabled, gates });
    io.stdout(JSON.stringify(resolved));
    return 0;
  } catch (err) {
    io.stderr(`activity-privacy: ${(err as Error).message}`);
    return 1;
  }
}

export function runActivityPrivacyCommand(
  rest: string[],
  io: ActivityPrivacyIo = defaultIo,
  stdinLines: readonly string[] = [],
): number {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(activityPrivacyHelp().trimEnd());
    return 0;
  }
  if (rest[0] === "retain") return runRetain(rest, io);
  if (rest[0] === "delete") return runActivityDeleteCommand(rest, stdinLines, io);
  if (rest[0] === "redact") return runActivityRedactCommand(rest, stdinLines, io);
  if (rest[0] === "gates") return runActivityGatesCommand(rest, io);
  io.stderr(`activity-privacy: unknown action "${rest[0]}".`);
  io.stderr(activityPrivacyHelp().trimEnd());
  return 1;
}

function runRetain(rest: string[], io: ActivityPrivacyIo): number {
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

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").split("\n");
}

export async function runActivityPrivacyBinaryCommand(rest: string[]): Promise<void> {
  const stdinNeeded = rest[0] === "delete" || rest[0] === "redact";
  const stdinLines = stdinNeeded && !process.stdin.isTTY ? await readStdinLines() : [];
  const code = runActivityPrivacyCommand(rest, defaultIo, stdinLines);
  if (code !== 0) process.exitCode = code;
}
