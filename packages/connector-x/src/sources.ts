/**
 * Pluggable X sources (issue #2009): official X MCP (paid, budget-
 * capped), a local corpus directory (zero credits), and a cookie-CLI
 * such as `bird` (zero credits). All three emit the same normalized
 * XPostRecord currency and degrade with a `skipped` reason instead of
 * throwing, except auth/config breakage which surfaces to the sync
 * report's `error` field.
 */

import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expandTildePath } from "@remnic/core";

import {
  type XBudgetConfig,
  type XCliSourceConfig,
  type XCorpusSourceConfig,
  type XMcpSourceConfig,
  resolveMcpClientCredentials,
} from "./config.js";
import { isXObject } from "./guards.js";
import { XCreditsDepletedError, XMcpClient, XMcpError } from "./mcp-client.js";
import { normalizeCorpusEntry, normalizeMcpPayload } from "./normalize.js";
import { XTokenStore } from "./token-store.js";
import type {
  XBudgetRuntime,
  XPostRecord,
  XRecordKind,
  XSource,
  XSourceFetchContext,
  XSourceFetchOutcome,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type XExecFn = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface XSourceDeps {
  /** Owning X user id — gates the own-posts timeline reads for MCP sources. */
  userId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  execImpl?: XExecFn;
}

/** Budget enforcement for paid (MCP) sources. */
export class XBudgetTracker implements XBudgetRuntime {
  pagesUsed = 0;
  reads = 0;
  readonly maxPages: number;

  constructor(
    private readonly budget: XBudgetConfig,
    private readonly monthSpendUsd: number
  ) {
    this.maxPages = budget.maxPagesPerSync;
  }

  canRead(): { ok: true } | { ok: false; reason: string; detail?: string } {
    if (this.pagesUsed >= this.budget.maxPagesPerSync) {
      return { ok: false, reason: "page-cap", detail: `${this.budget.maxPagesPerSync} pages/sync` };
    }
    const projected = this.monthSpendUsd + (this.reads + 1) * this.budget.costPerReadUsd;
    if (projected > this.budget.maxCostUsdPerMonth + 1e-9) {
      return {
        ok: false,
        reason: "monthly-cost-cap",
        detail: `$${projected.toFixed(2)} projected vs $${this.budget.maxCostUsdPerMonth.toFixed(2)} cap`,
      };
    }
    return { ok: true };
  }

  noteRead(): void {
    this.reads += 1;
  }
}

/** Zero-credit sources never consume budget. */
export const unlimitedBudget: XBudgetRuntime = {
  pagesUsed: 0,
  maxPages: Number.POSITIVE_INFINITY,
  canRead: () => ({ ok: true }),
  noteRead: () => {},
};

/** Builds the source adapter for a parsed source config entry. */
export function createXSource(
  config: XMcpSourceConfig | XCorpusSourceConfig | XCliSourceConfig,
  deps: XSourceDeps = {}
): XSource {
  if (config.kind === "mcp") return createMcpSource(config, deps);
  if (config.kind === "corpusDir") return createCorpusSource(config);
  return createCliSource(config, deps);
}

// ── MCP source ──────────────────────────────────────────────────────────────

function createMcpSource(config: XMcpSourceConfig, deps: XSourceDeps): XSource {
  const credentials = resolveMcpClientCredentials(config, deps.env ?? process.env);
  let client: XMcpClient | null = null;
  const getClient = (): XMcpClient => {
    if (client === null) {
      if (credentials.clientId === undefined || credentials.clientSecret === undefined) {
        throw new XMcpError(
          `source ${config.id}: OAuth2 client credentials missing — set auth on the source or REMNIC_X_CLIENT_ID/REMNIC_X_CLIENT_SECRET`
        );
      }
      const store = new XTokenStore({
        tokenFile: expandTildePath(credentials.tokenFile),
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
      client = new XMcpClient({
        url: config.url,
        tokenProvider: () => store.getAccessToken(),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      });
    }
    return client;
  };

  return {
    id: config.id,
    kind: "mcp",
    async fetch(ctx: XSourceFetchContext): Promise<XSourceFetchOutcome> {
      const records: XPostRecord[] = [];
      let reads = 0;
      let pages = 0;
      let skipped: XSourceFetchOutcome["skipped"];
      try {
        getClient();
      } catch (err) {
        return {
          records,
          reads,
          pages,
          skipped: {
            reason: "auth-not-configured",
            ...(err instanceof Error ? { detail: err.message } : {}),
          },
        };
      }

      const runKind = async (kind: XRecordKind, toolName: string, args: Record<string, unknown>) => {
        let nextToken: string | undefined;
        for (;;) {
          const gate = ctx.budget.canRead();
          if (!gate.ok) {
            skipped ??= {
              reason: gate.reason,
              ...(gate.detail !== undefined ? { detail: gate.detail } : {}),
            };
            return;
          }
          const page = await getClient().callTool(toolName, {
            ...args,
            ...(nextToken !== undefined ? { pagination_token: nextToken } : {}),
          });
          ctx.budget.noteRead();
          reads += 1;
          pages += 1;
          ctx.budget.pagesUsed = pages;
          const payload = parseToolJson(page.texts);
          if (payload === null) {
            skipped ??= { reason: "unexpected-payload", detail: `tool ${toolName}` };
            return;
          }
          const pageRecords = normalizeMcpPayload(payload, kind);
          records.push(...pageRecords);
          nextToken = nextPageToken(payload);
          if (nextToken === undefined || pageRecords.length === 0) return;
          // Stop-on-known: a page of entirely known posts means everything
          // deeper is older state we already ingested.
          if (pageRecords.every((record) => ctx.knownIds.has(record.postId))) return;
        }
      };

      try {
        await runKind("bookmark", config.bookmarksTool, { max_results: config.maxResults });
        if (deps.userId !== undefined) {
          await runKind("own_post", config.timelineTool, {
            id: deps.userId,
            max_results: config.maxResults,
          });
        }
      } catch (err) {
        if (err instanceof XCreditsDepletedError) {
          return { records, reads, pages, skipped: { reason: "credits-depleted" } };
        }
        throw err;
      }
      return { records, reads, pages, ...(skipped !== undefined ? { skipped } : {}) };
    },
  };
}

function parseToolJson(texts: string[]): unknown {
  const candidates = [texts.join("\n"), ...texts];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function nextPageToken(payload: unknown): string | undefined {
  if (!isXObject(payload)) return undefined;
  if (isXObject(payload.meta)) {
    for (const key of ["next_token", "next_cursor", "nextToken"] as const) {
      const value = payload.meta[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  for (const key of ["next_token", "next_cursor", "nextToken"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// ── Corpus directory source ─────────────────────────────────────────────────

function createCorpusSource(config: XCorpusSourceConfig): XSource {
  return {
    id: config.id,
    kind: "corpusDir",
    async fetch(): Promise<XSourceFetchOutcome> {
      const root = expandTildePath(config.path);
      let entries: string[];
      try {
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) {
          return { records: [], reads: 0, pages: 0, skipped: { reason: "corpus-dir-missing" } };
        }
        entries = (await readdir(root)).sort();
      } catch {
        return { records: [], reads: 0, pages: 0, skipped: { reason: "corpus-dir-missing" } };
      }
      const records: XPostRecord[] = [];
      let parseFailures = 0;
      let skippedFiles = 0;
      const rootReal = await realpath(root);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const filePath = path.join(root, name);
        try {
          const info = await lstat(filePath);
          if (info.isSymbolicLink()) {
            // Containment: a symlink may not point outside the corpus root.
            const target = await realpath(filePath);
            if (!(target === rootReal || target.startsWith(`${rootReal}${path.sep}`))) {
              skippedFiles += 1;
              continue;
            }
          } else if (!info.isFile()) {
            continue;
          }
          const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
          for (const entry of asEntryList(parsed)) {
            const record = normalizeCorpusEntry(entry, "bookmark");
            if (record !== null) records.push(record);
          }
        } catch {
          parseFailures += 1;
        }
      }
      const degraded =
        records.length === 0 && (parseFailures > 0 || skippedFiles > 0)
          ? {
              skipped: {
                reason: "corpus-empty",
                detail: `${parseFailures} unparseable, ${skippedFiles} out-of-root files skipped`,
              },
            }
          : {};
      return { records, reads: 0, pages: 1, ...degraded };
    },
  };
}

function asEntryList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isXObject(parsed) && Array.isArray(parsed.data)) return parsed.data;
  return [parsed];
}

// ── CLI source ──────────────────────────────────────────────────────────────

function createCliSource(config: XCliSourceConfig, deps: XSourceDeps): XSource {
  const exec = deps.execImpl ?? defaultExec;
  return {
    id: config.id,
    kind: "cli",
    async fetch(): Promise<XSourceFetchOutcome> {
      const records: XPostRecord[] = [];
      const commands: Array<{ args: string[]; kind: XRecordKind }> = [
        { args: config.bookmarksArgs, kind: "bookmark" },
        ...(config.postsArgs !== undefined ? [{ args: config.postsArgs, kind: "own_post" as const }] : []),
      ];
      let skipped: XSourceFetchOutcome["skipped"];
      for (const command of commands) {
        let stdout: string;
        try {
          ({ stdout } = await exec(config.bin, command.args));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          skipped = {
            reason: code === "ENOENT" ? "cli-not-installed" : "cli-failed",
            detail: code === "ENOENT" ? config.bin : exitDetail(err),
          };
          continue;
        }
        const parsed = parseStdout(stdout);
        if (parsed === null) {
          skipped = {
            reason: "cli-output-unparseable",
            detail: `${config.bin} ${command.args.join(" ")}`,
          };
          continue;
        }
        for (const entry of asEntryList(parsed)) {
          const record = normalizeCorpusEntry(entry, command.kind);
          if (record !== null) records.push(record);
        }
      }
      return { records, reads: 0, pages: commands.length, ...(skipped !== undefined ? { skipped } : {}) };
    },
  };
}

function exitDetail(err: unknown): string {
  if (isXObject(err) && typeof err.code === "number") return `exit ${err.code}`;
  return "non-zero exit";
}

function parseStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function defaultExec(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}
