/**
 * Wearables CLI runner — one implementation shared by every CLI host
 * (`remnic wearables ...` and `openclaw engram wearables ...`), so the
 * surfaces never fork (same rule as the recall-explain renderers).
 *
 * Flag validation is strict: every value-taking flag requires a value,
 * unknown flags error with the valid list, and invalid values reject
 * loudly (CLAUDE.md rules 14 + 51).
 */

import { WearablesInputError } from "./errors.js";
import type { WearablesService } from "./service.js";
import type { WearableSyncSummary } from "./types.js";

export interface WearablesCliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

const USAGE = `Usage: wearables <command> [options]

Commands:
  status                         Show configured sources, connectors, last sync
  check <source>                 Verify credentials/connectivity for a source
  sync [options]                 Pull + clean + store transcripts (and memories)
    --source <id>                Only this source (default: all enabled)
    --date <YYYY-MM-DD>          Exactly this day
    --days <n>                   Lookback window ending today (default 2)
    --force-memories             Re-extract memories for unchanged days
  transcript --date <YYYY-MM-DD> [--source <id>]
                                 Print the stored day transcript(s)
  search <query> [options]       Search stored transcripts
    --source <id>  --from <date>  --to <date>  --limit <n>
  memories [options]             List memories created from transcripts
    --source <id>  --date <date>  --limit <n>
  speakers list                  Show the speaker registry
  speakers self <name>           Set the wearer's display name
  speakers set <source> <key> <name> [--self]
                                 Map a provider speaker label to a name
  speakers remove <source> <key> Remove a speaker mapping
  corrections list               Show correction rules (config + state)
  corrections add <match> <replace> [--regex] [--case-sensitive] [--source <id>]
                                 Add a transcript correction rule
  corrections remove <index>     Remove a state correction rule by index

Add --json to status/sync/search/memories for machine-readable output.
`;

interface ParsedFlags {
  flags: Map<string, string | true>;
  positional: string[];
}

/** Flags that take a value (everything else is boolean). */
const VALUE_FLAGS = new Set([
  "--source",
  "--date",
  "--days",
  "--from",
  "--to",
  "--limit",
]);
const BOOLEAN_FLAGS = new Set([
  "--json",
  "--force-memories",
  "--regex",
  "--case-sensitive",
  "--self",
]);

function parseFlags(args: string[]): ParsedFlags {
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
        throw new WearablesInputError(`${arg} requires a value`);
      }
      flags.set(arg, value);
      index++;
      continue;
    }
    throw new WearablesInputError(
      `unknown flag '${arg}' — valid flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].join(", ")}`,
    );
  }
  return { flags, positional };
}

function flagString(parsed: ParsedFlags, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagInt(parsed: ParsedFlags, name: string): number | undefined {
  const value = flagString(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (
    !Number.isFinite(parsedValue) ||
    !Number.isInteger(parsedValue) ||
    parsedValue < 1
  ) {
    throw new WearablesInputError(`${name} expects a positive integer (got '${value}')`);
  }
  return parsedValue;
}

function renderSyncSummary(summary: WearableSyncSummary): string {
  const lines = [
    `${summary.source}: ${summary.conversations} conversation${summary.conversations === 1 ? "" : "s"} across ${summary.days.length} day${summary.days.length === 1 ? "" : "s"} (${summary.days.join(", ")})`,
    `  segments kept/dropped:  ${summary.segmentsKept}/${summary.segmentsDropped}`,
    `  redactions applied:     ${summary.redactions}`,
    `  corrections applied:    ${summary.correctionsApplied}`,
    `  transcripts written:    ${summary.transcriptsWritten.length > 0 ? summary.transcriptsWritten.join(", ") : "(none — unchanged)"}`,
    `  memories created:       ${summary.memoriesCreated} (skipped ${summary.memoriesSkipped})`,
  ];
  if (summary.memoriesPromoted > 0) {
    lines.push(`  memories promoted:      ${summary.memoriesPromoted}`);
  }
  if (summary.memoriesDemoted > 0) {
    lines.push(`  memories demoted:       ${summary.memoriesDemoted}`);
  }
  if (summary.nativeMemoriesImported > 0) {
    lines.push(`  native memories queued: ${summary.nativeMemoriesImported}`);
  }
  for (const warning of summary.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

/**
 * Run a wearables CLI command. Returns a process exit code; all output
 * goes through `io`.
 */
export async function runWearablesCliCommand(
  service: WearablesService,
  args: string[],
  io: WearablesCliIo,
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
        const parsed = parseFlags(rest);
        const status = await service.status();
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return 0;
        }
        io.stdout.write(
          `Wearables: ${status.enabled ? "enabled" : "disabled"} (timezone ${status.timezone})\n`,
        );
        if (status.sources.length === 0) {
          io.stdout.write(
            "No sources configured. Add wearables.sources.<id> to the plugin config.\n",
          );
          return 0;
        }
        for (const source of status.sources) {
          io.stdout.write(
            `  ${source.source} (${source.displayName}): ${source.enabled ? "enabled" : "disabled"}, ` +
              `connector ${source.connectorInstalled ? "installed" : `MISSING — npm install @remnic/connector-${source.source}`}, ` +
              `memoryMode ${source.memoryMode}, ` +
              `${source.transcriptDays} transcript day${source.transcriptDays === 1 ? "" : "s"}, ` +
              `last sync ${source.lastSyncAt ?? "never"}\n`,
          );
        }
        return 0;
      }
      case "check": {
        const [sourceId] = rest;
        if (!sourceId) {
          throw new WearablesInputError("check requires a source id (e.g. wearables check limitless)");
        }
        const result = await service.checkAuth(sourceId);
        io.stdout.write(
          result.ok
            ? `${sourceId}: OK${result.detail ? ` — ${result.detail}` : ""}\n`
            : `${sourceId}: FAILED${result.detail ? ` — ${result.detail}` : ""}\n`,
        );
        return result.ok ? 0 : 1;
      }
      case "sync": {
        const parsed = parseFlags(rest);
        if (parsed.positional.length > 0) {
          throw new WearablesInputError(
            `unexpected argument '${parsed.positional[0]}' — sync takes flags only`,
          );
        }
        const summaries = await service.sync({
          source: flagString(parsed, "--source"),
          date: flagString(parsed, "--date"),
          days: flagInt(parsed, "--days"),
          forceMemories: parsed.flags.has("--force-memories"),
        });
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify({ summaries }, null, 2)}\n`);
          return 0;
        }
        for (const summary of summaries) {
          io.stdout.write(`${renderSyncSummary(summary)}\n`);
        }
        io.stdout.write("OK\n");
        return 0;
      }
      case "transcript": {
        const parsed = parseFlags(rest);
        const date = flagString(parsed, "--date");
        if (!date) {
          throw new WearablesInputError("transcript requires --date <YYYY-MM-DD>");
        }
        const views = await service.dayTranscript(date, flagString(parsed, "--source"));
        if (views.length === 0) {
          io.stderr.write(`No stored transcripts for ${date}.\n`);
          return 1;
        }
        for (const view of views) {
          if (views.length > 1) {
            io.stdout.write(`\n===== ${view.source} — ${view.date} =====\n\n`);
          }
          if (view.overlapsWith.length > 0) {
            io.stdout.write(
              `(also recorded by: ${view.overlapsWith.join(", ")})\n\n`,
            );
          }
          io.stdout.write(`${view.body}\n`);
        }
        return 0;
      }
      case "search": {
        const parsed = parseFlags(rest);
        const query = parsed.positional.join(" ").trim();
        if (query.length === 0) {
          throw new WearablesInputError("search requires a query");
        }
        const results = await service.searchTranscripts(query, {
          source: flagString(parsed, "--source"),
          from: flagString(parsed, "--from"),
          to: flagString(parsed, "--to"),
          limit: flagInt(parsed, "--limit"),
        });
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
          return 0;
        }
        if (results.length === 0) {
          io.stdout.write("No matches.\n");
          return 0;
        }
        for (const result of results) {
          io.stdout.write(
            `${result.source} ${result.date}  ${result.snippet}\n`,
          );
        }
        if (results.some((result) => result.backend === "scan")) {
          io.stdout.write(
            "(search index unavailable — results from bounded text scan)\n",
          );
        }
        return 0;
      }
      case "memories": {
        const parsed = parseFlags(rest);
        const memories = await service.transcriptMemories({
          source: flagString(parsed, "--source"),
          date: flagString(parsed, "--date"),
          limit: flagInt(parsed, "--limit"),
        });
        if (parsed.flags.has("--json")) {
          io.stdout.write(`${JSON.stringify({ memories }, null, 2)}\n`);
          return 0;
        }
        if (memories.length === 0) {
          io.stdout.write("No wearable-derived memories found.\n");
          return 0;
        }
        for (const memory of memories) {
          const status = memory.status === "pending_review" ? " [pending review]" : "";
          io.stdout.write(
            `${memory.id} (${memory.source}${memory.date ? ` ${memory.date}` : ""})${status}\n  ${memory.content.split("\n")[0]}\n`,
          );
        }
        return 0;
      }
      case "speakers": {
        const [action, ...speakerArgs] = rest;
        if (action === "list" || action === undefined) {
          const registry = await service.listSpeakers();
          io.stdout.write(`Self: ${registry.selfName}\n`);
          const entries = Object.entries(registry.speakers);
          if (entries.length === 0) {
            io.stdout.write("No speaker overrides stored.\n");
            return 0;
          }
          for (const [key, override] of entries) {
            io.stdout.write(
              `  ${key} -> ${override.name}${override.isSelf ? " (you)" : ""}\n`,
            );
          }
          return 0;
        }
        if (action === "self") {
          const name = speakerArgs.join(" ").trim();
          if (name.length === 0) {
            throw new WearablesInputError("speakers self requires a name");
          }
          await service.setSelfName(name);
          io.stdout.write(`Self name set to '${name}'.\n`);
          return 0;
        }
        if (action === "set") {
          const parsed = parseFlags(speakerArgs);
          const [sourceId, speakerKey, ...nameParts] = parsed.positional;
          const name = nameParts.join(" ").trim();
          if (!sourceId || !speakerKey || name.length === 0) {
            throw new WearablesInputError(
              "speakers set requires: <source> <speakerKey> <name>",
            );
          }
          await service.setSpeaker(sourceId, speakerKey, name, {
            isSelf: parsed.flags.has("--self"),
          });
          io.stdout.write(`Mapped ${sourceId}:${speakerKey} -> ${name}.\n`);
          io.stdout.write(
            "(re-run `wearables sync --force-memories` to rebuild stored transcripts with the new label)\n",
          );
          return 0;
        }
        if (action === "remove") {
          const [sourceId, speakerKey] = speakerArgs;
          if (!sourceId || !speakerKey) {
            throw new WearablesInputError("speakers remove requires: <source> <speakerKey>");
          }
          await service.removeSpeaker(sourceId, speakerKey);
          io.stdout.write(`Removed mapping for ${sourceId}:${speakerKey}.\n`);
          return 0;
        }
        throw new WearablesInputError(
          `unknown speakers action '${action}' — expected list, self, set, or remove`,
        );
      }
      case "corrections": {
        const [action, ...correctionArgs] = rest;
        if (action === "list" || action === undefined) {
          const { fromConfig, fromState, stateFilePath } = await service.listCorrections();
          if (fromConfig.length === 0 && fromState.length === 0) {
            io.stdout.write("No correction rules configured.\n");
            return 0;
          }
          if (fromConfig.length > 0) {
            io.stdout.write("From config (wearables.corrections):\n");
            fromConfig.forEach((rule, index) => {
              io.stdout.write(`  [config ${index}] ${formatRule(rule)}\n`);
            });
          }
          if (fromState.length > 0) {
            io.stdout.write(`From state (${stateFilePath}):\n`);
            fromState.forEach((rule, index) => {
              io.stdout.write(`  [${index}] ${formatRule(rule)}\n`);
            });
          }
          return 0;
        }
        if (action === "add") {
          const parsed = parseFlags(correctionArgs);
          const [match, replace] = parsed.positional;
          if (match === undefined || replace === undefined) {
            throw new WearablesInputError(
              'corrections add requires: <match> <replace> (quote multi-word values)',
            );
          }
          const sourceFlag = flagString(parsed, "--source");
          await service.addCorrection({
            match,
            replace,
            ...(parsed.flags.has("--regex") ? { regex: true } : {}),
            ...(parsed.flags.has("--case-sensitive") ? { caseInsensitive: false } : {}),
            ...(sourceFlag !== undefined ? { sources: [sourceFlag] } : {}),
          });
          io.stdout.write(`Added correction: ${JSON.stringify(match)} -> ${JSON.stringify(replace)}.\n`);
          return 0;
        }
        if (action === "remove") {
          const [indexRaw] = correctionArgs;
          const index = Number(indexRaw);
          if (
            indexRaw === undefined ||
            !Number.isInteger(index) ||
            index < 0
          ) {
            throw new WearablesInputError("corrections remove requires a non-negative index");
          }
          const removed = await service.removeCorrection(index);
          io.stdout.write(`Removed correction ${formatRule(removed)}.\n`);
          return 0;
        }
        throw new WearablesInputError(
          `unknown corrections action '${action}' — expected list, add, or remove`,
        );
      }
      default:
        throw new WearablesInputError(
          `unknown wearables command '${command}'\n\n${USAGE}`,
        );
    }
  } catch (err) {
    if (err instanceof WearablesInputError) {
      io.stderr.write(`wearables: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function formatRule(rule: {
  match: string;
  replace: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  sources?: string[];
}): string {
  const parts = [`${JSON.stringify(rule.match)} -> ${JSON.stringify(rule.replace)}`];
  if (rule.regex === true) parts.push("(regex)");
  if (rule.caseInsensitive === false) parts.push("(case-sensitive)");
  if (rule.sources && rule.sources.length > 0) {
    parts.push(`(sources: ${rule.sources.join(", ")})`);
  }
  return parts.join(" ");
}
