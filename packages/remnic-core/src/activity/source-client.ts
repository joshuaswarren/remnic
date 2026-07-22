import type { ActivitySnapshot, ActivitySnapshotPage, ActivitySourceCheck, ActivitySourceClient } from "./types.js";

export interface ActivityHttpSourceClientOptions {
  machineLabel: string;
  baseUrl: string;
  token?: string;
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
    app: stringField(value, "app"),
    windowTitle: stringField(value, "windowTitle"),
    ...(browserUrl === undefined ? {} : { browserUrl }),
    text: stringField(value, "text"),
    textSource,
    contentHash: stringField(value, "contentHash"),
    ...(simhash === undefined ? {} : { simhash }),
  };
}

function responsePage(value: unknown, machine: string): ActivitySnapshotPage {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) {
    throw new TypeError("activity source response has no snapshots array");
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    throw new TypeError("activity source response has invalid nextCursor");
  }
  return {
    snapshots: value.snapshots.map((snapshot) => snapshotFromWire(snapshot, machine)),
    nextCursor: value.nextCursor,
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

  constructor(options: ActivityHttpSourceClientOptions) {
    if (options.machineLabel.trim().length === 0) throw new RangeError("activity source machine label must not be empty");
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new RangeError("activity source baseUrl must use HTTP or HTTPS");
    }
    this.machineLabel = options.machineLabel;
    this.baseUrl = parsed.toString();
    this.token = options.token;
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(url, {
      headers: this.token === undefined ? undefined : { authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!response.ok) throw new Error(`activity source HTTP ${response.status}`);
    return response;
  }

  async verify(signal?: AbortSignal): Promise<ActivitySourceCheck> {
    try {
      await this.request(requestUrl(this.baseUrl, "/v1/health", {}), signal);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, detail: error instanceof Error ? error.message.replace("activity source ", "") : "request failed" };
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
