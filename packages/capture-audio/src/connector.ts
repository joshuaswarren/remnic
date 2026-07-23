/**
 * `desktop` wearable source connector (issue #1897, component 4).
 *
 * À-la-carte optional companion of @remnic/core: installing core alone
 * never pulls this in; core discovers it at runtime via a
 * computed-specifier dynamic import (registry entry {id:"desktop",
 * suffix:"capture-audio"}) or via a direct import of @remnic/capture-audio,
 * which self-registers idempotently.
 *
 * The connector is a pure API client + normalizer over the capture-audio
 * daemon's loopback HTTP API: no file IO beyond reading the local token,
 * no memory writes, no pipeline behavior (all of that stays in core so
 * desktop audio gets the same cleanup/corrections/trust gating as every
 * other wearable source).
 *
 * Token resolution (in order): settings.apiKey (config) ->
 * REMNIC_CAPTURE_AUDIO_TOKEN env -> the daemon's local token file
 * (~/.remnic/capture/token) when the base URL is loopback.
 */

import { readFileSync } from "node:fs";

import {
  registerWearableConnector,
  getWearableConnector,
  type WearableAuthCheck,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableConversation,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableSourceConnector,
  type WearableTranscriptSegment,
} from "@remnic/core";

import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import { capturePaths } from "./paths.js";
import { isLoopbackHost } from "./util.js";
import type { ConversationPage, DaemonConversation, DaemonSegment } from "./spool.js";

export const DESKTOP_SOURCE_ID = "desktop";
export const DESKTOP_DISPLAY_NAME = "Desktop audio";
const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

/** Error raised for a genuine backend failure (never for an empty day). */
export class DesktopDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopDaemonError";
  }
}

function baseUrlIsLoopback(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the daemon bearer token. The local token file is read ONLY for
 * a loopback base URL — a remote reader must supply the token explicitly
 * (config/env), never inherit this machine's local token.
 */
export function resolveCaptureAudioToken(
  configured: string | undefined,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  const fromEnv = env.REMNIC_CAPTURE_AUDIO_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  if (baseUrlIsLoopback(baseUrl)) {
    try {
      const token = readFileSync(capturePaths().tokenPath, "utf8").trim();
      if (token.length > 0) return token;
    } catch {
      // no local token file — treat as unauthenticated (health will 401)
    }
  }
  return undefined;
}

function daemonSegmentToWearable(seg: DaemonSegment): WearableTranscriptSegment {
  return {
    text: seg.textRaw,
    // The wearables speaker registry owns naming; the connector only
    // supplies the stable per-source key (spk_<n> | self | "unknown").
    speakerKey: seg.speakerKey ?? "unknown",
    isWearer: seg.isWearer,
    startIso: seg.startUtc,
    endIso: seg.endUtc,
  };
}

export function daemonConversationToWearable(conv: DaemonConversation): WearableConversation {
  return {
    id: conv.id,
    source: DESKTOP_SOURCE_ID,
    startIso: conv.startedAtUtc,
    endIso: conv.endedAtUtc ?? undefined,
    segments: conv.segments.map(daemonSegmentToWearable),
  };
}

interface DesktopClientOptions {
  baseUrl: string;
  token: string | undefined;
}

class DesktopClient {
  #baseUrl: string;
  #token: string | undefined;

  constructor(options: DesktopClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
  }

  #headers(): Record<string, string> {
    return this.#token ? { authorization: `Bearer ${this.#token}` } : {};
  }

  async verifyAuth(signal?: AbortSignal): Promise<WearableAuthCheck> {
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/v1/health`, { headers: this.#headers(), signal });
    } catch {
      // Connection refused / DNS / offline: the daemon isn't running.
      // This is NOT an auth failure and must never throw (AC2).
      return { ok: false, detail: "unreachable" };
    }
    if (res.status === 401) return { ok: false, detail: "unauthorized" };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown; version?: unknown };
    if (body.ok === true) {
      return { ok: true, detail: typeof body.version === "string" ? `capture-audio ${body.version}` : undefined };
    }
    return { ok: false, detail: "unhealthy" };
  }

  async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
    const url = new URL(`${this.#baseUrl}/v1/conversations`);
    url.searchParams.set("date", opts.date);
    url.searchParams.set("timezone", opts.timezone);
    if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
    let res: Response;
    try {
      res = await fetch(url, { headers: this.#headers(), signal: opts.signal });
    } catch {
      throw new DesktopDaemonError(
        `desktop capture daemon unreachable at ${this.#baseUrl} (is remnic-capture-audio running?)`,
      );
    }
    if (!res.ok) {
      // A non-2xx is a backend/auth failure, distinct from an empty day.
      throw new DesktopDaemonError(`desktop capture daemon returned HTTP ${res.status}`);
    }
    const page = (await res.json()) as ConversationPage;
    if (!page || !Array.isArray(page.conversations)) {
      throw new DesktopDaemonError("desktop capture daemon returned a malformed conversations page");
    }
    return {
      conversations: page.conversations.map(daemonConversationToWearable),
      nextCursor: page.nextCursor ?? null,
    };
  }
}

export function createDesktopConnector(options: WearableConnectorFactoryOptions): WearableSourceConnector {
  const baseUrl = options.settings.baseUrl?.trim() || DEFAULT_BASE_URL;
  // Token resolved lazily so `wearables status` works without a token and
  // env/file changes take effect without a connector rebuild.
  let client: DesktopClient | null = null;
  const getClient = (): DesktopClient => {
    if (!client) {
      client = new DesktopClient({ baseUrl, token: resolveCaptureAudioToken(options.settings.apiKey, baseUrl) });
    }
    return client;
  };
  return {
    id: DESKTOP_SOURCE_ID,
    displayName: DESKTOP_DISPLAY_NAME,
    verifyAuth: (signal?: AbortSignal) => getClient().verifyAuth(signal),
    fetchConversations: (opts: WearableFetchOptions) => getClient().fetchConversations(opts),
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: DESKTOP_SOURCE_ID,
  displayName: DESKTOP_DISPLAY_NAME,
  factory: createDesktopConnector,
};

/** Idempotently register the desktop connector with the core registry. */
export function ensureDesktopConnectorRegistered(): boolean {
  if (getWearableConnector(DESKTOP_SOURCE_ID) !== undefined) return false;
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureDesktopConnectorRegistered();
