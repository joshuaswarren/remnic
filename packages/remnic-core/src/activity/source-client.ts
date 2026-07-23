import { validateActivityBaseUrl } from "./config.js";
import { displayErrorDetail } from "../runtime/better-sqlite.js";
import type { ActivitySnapshot, ActivitySnapshotPage, ActivitySourceCheck, ActivitySourceClient } from "./types.js";

/** Abort a stalled capture-daemon request rather than hang the whole sync. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ActivityHttpSourceClientOptions {
  machineLabel: string;
  baseUrl: string;
  token?: string;
  /** Per-request timeout in ms; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new TypeError(`activity source response has no valid ${field}`);
  }
  return result;
}

/**
 * Content fields (app/windowTitle/text) may be legitimately empty: a foreground
 * window can be untitled or have no extractable text. Require the string TYPE
 * (a missing/non-string field still fails loudly) but tolerate "", matching the
 * durable store's contract — else a blank window poisons the day cursor by
 * failing every replay of the same page.
 */
function contentStringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new TypeError(`activity source response has invalid ${field}`);
  }
  return result;
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string") throw new TypeError(`activity source response has invalid ${field}`);
  return result;
}

function snapshotFromWire(value: unknown, machine: string): ActivitySnapshot {
  if (!isRecord(value)) throw new TypeError("activity source returned a non-object snapshot");
  const textSource = stringField(value, "textSource");
  if (textSource !== "ax" && textSource !== "ocr") {
    throw new TypeError("activity source response has invalid textSource");
  }
  const browserUrl = optionalStringField(value, "browserUrl");
  const simhash = optionalStringField(value, "simhash");
  return {
    machine,
    capturedAtUtc: stringField(value, "capturedAtUtc"),
    app: contentStringField(value, "app"),
    windowTitle: contentStringField(value, "windowTitle"),
    ...(browserUrl === undefined ? {} : { browserUrl }),
    text: contentStringField(value, "text"),
    textSource,
    contentHash: stringField(value, "contentHash"),
    ...(simhash === undefined ? {} : { simhash }),
  };
}

function responsePage(value: unknown, machine: string): ActivitySnapshotPage {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) {
    throw new TypeError("activity source response has no snapshots array");
  }
  // A missing/undefined nextCursor (field omitted, not JSON null) is normal
  // end-of-pagination — only a present non-string value is invalid.
  const nextCursor = value.nextCursor === undefined ? null : value.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new TypeError("activity source response has invalid nextCursor");
  }
  const generation = optionalStringField(value, "generation");
  return {
    snapshots: value.snapshots.map((snapshot) => snapshotFromWire(snapshot, machine)),
    nextCursor,
    ...(generation === undefined ? {} : { generation }),
  };
}

function requestUrl(baseUrl: string, path: string, query: Record<string, string | undefined>): string {
  const url = new URL(path, baseUrl);
  const parts = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  url.search = parts.join("&");
  return url.toString();
}

export class ActivityHttpSourceClient implements ActivitySourceClient {
  readonly machineLabel: string;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: ActivityHttpSourceClientOptions) {
    if (options.machineLabel.trim().length === 0) throw new RangeError("activity source machine label must not be empty");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError("activity source timeoutMs must be a positive number");
    }
    this.machineLabel = options.machineLabel;
    this.baseUrl = validateActivityBaseUrl(options.baseUrl).toString();
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    // Bound every request so a stalled daemon aborts instead of hanging the
    // sync forever; honor the caller's signal too when one is supplied.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(url, {
      headers: this.token === undefined ? undefined : { authorization: `Bearer ${this.token}` },
      signal: composed,
    });
    if (!response.ok) throw new Error(`activity source HTTP ${response.status}`);
    return response;
  }

  async verify(signal?: AbortSignal): Promise<ActivitySourceCheck> {
    try {
      await this.request(requestUrl(this.baseUrl, "/v1/health", {}), signal);
      return { ok: true };
    } catch (error: unknown) {
      // The controlled `HTTP <status>` message is safe to surface verbatim;
      // anything else (network/runtime fetch errors that can embed hostnames or
      // absolute paths) is reduced to a sanitized name+code via
      // displayErrorDetail, matching the wearables operator-facing path.
      const detail =
        error instanceof Error && error.message.startsWith("activity source HTTP ")
          ? error.message.slice("activity source ".length)
          : displayErrorDetail(error) || "request failed";
      return { ok: false, detail };
    }
  }

  async fetchSnapshots(opts: {
    date: string;
    timezone: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<ActivitySnapshotPage> {
    const response = await this.request(
      requestUrl(this.baseUrl, "/v1/snapshots", {
        date: opts.date,
        timezone: opts.timezone,
        cursor: opts.cursor ?? undefined,
      }),
      opts.signal,
    );
    return responsePage(await response.json(), this.machineLabel);
  }
}
