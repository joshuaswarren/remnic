/**
 * Meetings CLI runner (issue #1900) — one implementation shared by every CLI
 * host (`remnic meetings ...` and `openclaw engram meetings ...`) so the
 * surfaces never fork (same rule as the wearables/recall-explain runners).
 *
 * Flag validation is strict: value-taking flags require a value, unknown flags
 * error with the valid list, malformed dates/ids reject loudly, and a missing
 * record is a caller error — all `MeetingsInputError` → exit code 1 (CLAUDE.md
 * rules 14 + 51). Backend faults bubble to the host's 500 handler.
 */

import { isValidTranscriptDate } from "../wearables/day-store.js";
import type { MeetingsBuilder, MeetingsDayBuildSummary } from "./build.js";
import { MeetingsInputError } from "./errors.js";
import { meetingIdDate, type MeetingRecordStore, type MeetingRecordSummary } from "./store.js";

export interface MeetingsCliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

/** Everything the runner drives. Injected so tests wire a store + builder over
 *  synthetic fixtures with no real filesystem. */
export interface MeetingsCliDeps {
  store: MeetingRecordStore;
  builder: MeetingsBuilder;
}

const USAGE = `Usage: meetings <command> [options]

Commands:
  list [--date <YYYY-MM-DD>]     List meeting records (all days, or one day)
  show <meeting-id>              Print a stored meeting record
  build --date <YYYY-MM-DD>      Detect + fuse + store the day's meetings

Add --json to list/build for machine-readable output.
`;

const VALUE_FLAGS: Record<string, true> = { "--date": true };
const BOOLEAN_FLAGS: Record<string, true> = { "--json": true };

interface ParsedFlags {
  flags: Map<string, string | true>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS[arg] === true) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new MeetingsInputError(`flag ${arg} requires a value`);
      }
      flags.set(arg, value);
      i++;
      continue;
    }
    if (BOOLEAN_FLAGS[arg] === true) {
      flags.set(arg, true);
      continue;
    }
    const known = [...Object.keys(VALUE_FLAGS), ...Object.keys(BOOLEAN_FLAGS)].sort().join(", ");
    throw new MeetingsInputError(`unknown flag ${arg} (valid: ${known})`);
  }
  return { flags, positional };
}

function requireDate(parsed: ParsedFlags): string {
  const value = parsed.flags.get("--date");
  if (typeof value !== "string") {
    throw new MeetingsInputError("--date <YYYY-MM-DD> is required");
  }
  if (!isValidTranscriptDate(value)) {
    throw new MeetingsInputError(`--date must be a real YYYY-MM-DD; got '${value}'`);
  }
  return value;
}

function renderSummaryLine(summary: MeetingRecordSummary): string {
  const attendees = summary.attendees.length > 0 ? summary.attendees.join(", ") : "(none)";
  const sources = summary.sources.length > 0 ? summary.sources.join("+") : "(none)";
  const corroborated =
    summary.corroboratedBy.length > 0 ? ` corroborated=${summary.corroboratedBy.join("+")}` : "";
  return (
    `  ${summary.id}  ${summary.startUtc}–${summary.endUtc}  [${summary.detectionSource}]` +
    ` sources=${sources}${corroborated} attendees=${attendees} snapshots=${summary.snapshotCount}`
  );
}

function renderBuildSummary(summary: MeetingsDayBuildSummary): string {
  if (!summary.enabled) {
    return `meetings disabled — set meetings.enabled=true to build (${summary.date})`;
  }
  const lines = [
    `${summary.date}: ${summary.meetings.length} meeting${summary.meetings.length === 1 ? "" : "s"} ` +
      `(${summary.built} written, ${summary.skipped} unchanged)`,
  ];
  for (const meeting of summary.meetings) {
    const sources = meeting.sources.length > 0 ? meeting.sources.join("+") : "(none)";
    lines.push(
      `  ${meeting.id}  ${meeting.startUtc}–${meeting.endUtc}  [${meeting.detectionSource}]` +
        ` sources=${sources} snapshots=${meeting.snapshotCount} ${meeting.written ? "written" : "unchanged"}`,
    );
  }
  return lines.join("\n");
}

/** Run a meetings CLI command. Returns a process exit code; all output via `io`. */
export async function runMeetingsCliCommand(
  deps: MeetingsCliDeps,
  args: string[],
  io: MeetingsCliIo,
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
      case "list": {
        const parsed = parseFlags(rest);
        const json = parsed.flags.has("--json");
        const dateFlag = parsed.flags.get("--date");
        if (typeof dateFlag === "string") {
          if (!isValidTranscriptDate(dateFlag)) {
            throw new MeetingsInputError(`--date must be a real YYYY-MM-DD; got '${dateFlag}'`);
          }
          const summaries = await deps.store.listMeetingSummaries(dateFlag);
          if (json) {
            io.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
            return 0;
          }
          if (summaries.length === 0) {
            io.stdout.write(`No meetings for ${dateFlag}.\n`);
            return 0;
          }
          io.stdout.write(`${dateFlag}:\n`);
          for (const summary of summaries) io.stdout.write(`${renderSummaryLine(summary)}\n`);
          return 0;
        }
        const dates = await deps.store.listMeetingDates();
        if (json) {
          const out: Record<string, MeetingRecordSummary[]> = {};
          for (const date of dates) out[date] = await deps.store.listMeetingSummaries(date);
          io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
          return 0;
        }
        if (dates.length === 0) {
          io.stdout.write("No meetings recorded.\n");
          return 0;
        }
        for (const date of dates) {
          const summaries = await deps.store.listMeetingSummaries(date);
          io.stdout.write(`${date}:\n`);
          for (const summary of summaries) io.stdout.write(`${renderSummaryLine(summary)}\n`);
        }
        return 0;
      }
      case "show": {
        const parsed = parseFlags(rest);
        const id = parsed.positional[0];
        if (id === undefined) {
          throw new MeetingsInputError("show requires a meeting id");
        }
        const date = meetingIdDate(id);
        if (date === null) {
          throw new MeetingsInputError(`invalid meeting id '${id}' — expected mtg-YYYY-MM-DD-<hash>`);
        }
        // meetingIdDate matches the id's SHAPE; a syntactically valid but
        // impossible calendar date (e.g. mtg-2026-13-40-...) must surface as a
        // clean input error, not a 500 from the store's path validator.
        if (!isValidTranscriptDate(date)) {
          throw new MeetingsInputError(`invalid meeting id '${id}' — '${date}' is not a real calendar date`);
        }
        const raw = await deps.store.readMeetingRecord(date, id);
        if (raw === null) {
          throw new MeetingsInputError(`meeting '${id}' not found`);
        }
        io.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
        return 0;
      }
      case "build": {
        const parsed = parseFlags(rest);
        const date = requireDate(parsed);
        const summary = await deps.builder.buildDay(date);
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
          return 0;
        }
        io.stdout.write(`${renderBuildSummary(summary)}\n`);
        return 0;
      }
      default:
        throw new MeetingsInputError(`unknown meetings command '${command}'\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof MeetingsInputError) {
      io.stderr.write(`meetings: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
