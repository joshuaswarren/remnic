/**
 * Desktop wearable connector — the à-la-carte companion of @remnic/core.
 *
 * Installing core alone never pulls @remnic/capture-audio in; core
 * discovers it at runtime via a computed-specifier dynamic import (see
 * wearables/registry.ts) or a direct import of this module, which
 * self-registers idempotently. The connector is a pure reader over the
 * local daemon's HTTP API: it never owns the capture process, transcribes
 * audio, or invents conversations.
 *
 * Token precedence: explicit `wearables.sources.desktop.apiKey`, then the
 * `REMNIC_CAPTURE_AUDIO_TOKEN` environment variable, then the daemon's
 * on-disk token file — the file is read ONLY for a loopback base URL, so a
 * local credential is never sent to a remote host.
 */

import { readFileSync } from "node:fs";

import {
  registerWearableConnector,
  getWearableConnector,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableSourceConnector,
} from "@remnic/core";

import { captureBaseDir, capturePaths } from "./paths.js";
import { isLoopbackHost } from "./util.js";
import { DesktopCaptureClient, DESKTOP_DEFAULT_BASE_URL } from "./http-client.js";
import { daemonConversationToWearable, DESKTOP_SOURCE_ID } from "./normalize.js";

export {
  DesktopApiError,
  DesktopCaptureClient,
  DESKTOP_DEFAULT_BASE_URL,
} from "./http-client.js";
export type {
  DesktopCaptureClientOptions,
  ListConversationsParams,
} from "./http-client.js";
export { daemonConversationToWearable, DESKTOP_SOURCE_ID } from "./normalize.js";

const DISPLAY_NAME = "Desktop Audio Capture";

export function resolveDesktopBaseUrl(configuredBaseUrl: string | undefined): string {
  const configured = configuredBaseUrl?.trim();
  return configured && configured.length > 0 ? configured : DESKTOP_DEFAULT_BASE_URL;
}

export function resolveDesktopToken(
  configuredToken: string | undefined,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = configuredToken?.trim();
  if (configured && configured.length > 0) return configured;
  const fromEnv = env.REMNIC_CAPTURE_AUDIO_TOKEN?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Reading and sending the daemon's on-disk token is only safe when the
  // target is loopback; never leak a local credential to a remote host.
  if (!isLoopbackBaseUrl(baseUrl)) return undefined;
  try {
    const token = readFileSync(capturePaths(captureBaseDir(env)).tokenPath, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function createDesktopConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  const baseUrl = resolveDesktopBaseUrl(options.settings.baseUrl);
  // Token resolution is deferred to first use so `wearables status` works
  // without a running daemon and a newly written token file is picked up
  // without a restart.
  let client: DesktopCaptureClient | null = null;
  const getClient = (): DesktopCaptureClient => {
    if (!client) {
      client = new DesktopCaptureClient({
        baseUrl,
        token: resolveDesktopToken(options.settings.apiKey, baseUrl),
      });
    }
    return client;
  };

  return {
    id: DESKTOP_SOURCE_ID,
    displayName: DISPLAY_NAME,
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
      const page = await getClient().listConversations({
        date: opts.date,
        timezone: opts.timezone,
        cursor: opts.cursor,
        signal: opts.signal,
      });
      return {
        conversations: page.conversations.map(daemonConversationToWearable),
        nextCursor: page.nextCursor,
      };
    },
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: DESKTOP_SOURCE_ID,
  displayName: DISPLAY_NAME,
  factory: createDesktopConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing
 * this module registers it as a side effect; calling this again is safe
 * (returns false when already registered).
 */
export function ensureDesktopConnectorRegistered(): boolean {
  if (getWearableConnector(DESKTOP_SOURCE_ID) !== undefined) {
    return false;
  }
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureDesktopConnectorRegistered();
