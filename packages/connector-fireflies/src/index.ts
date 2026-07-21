/**
 * @remnic/connector-fireflies — Fireflies.ai meeting-transcript connector.
 *
 * À-la-carte optional companion of @remnic/core: installing core alone
 * never pulls this in; core discovers it at runtime via a
 * computed-specifier dynamic import (see wearables/registry.ts) or via
 * a direct import of this module, which self-registers idempotently.
 *
 * API key: `wearables.sources.fireflies.apiKey`, else the
 * `REMNIC_FIREFLIES_API_KEY` / `FIREFLIES_API_KEY` environment
 * variables (checked in that order). Create a key under
 * Settings → Developer settings in the Fireflies app.
 */

import {
  registerWearableConnector,
  getWearableConnector,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableSourceConnector,
} from "@remnic/core";

import { FirefliesClient } from "./client.js";
import { FIREFLIES_SOURCE_ID, firefliesDayWindow, transcriptToConversation } from "./normalize.js";

export {
  FirefliesClient,
  FirefliesApiError,
  FIREFLIES_DEFAULT_ENDPOINT,
  TRANSCRIPTS_MAX_PAGE_SIZE,
} from "./client.js";
export type {
  FirefliesTranscript,
  FirefliesSentence,
  FirefliesSummary,
  FirefliesSpeaker,
  TranscriptsPage,
  FirefliesClientOptions,
} from "./client.js";
export {
  FIREFLIES_SOURCE_ID,
  firefliesDayWindow,
  transcriptToConversation,
} from "./normalize.js";

const FIREFLIES_DISPLAY_NAME = "Fireflies.ai";

export function resolveFirefliesApiKey(
  configuredKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configuredKey === "string" && configuredKey.trim().length > 0) {
    return configuredKey.trim();
  }
  // REMNIC_* first, then the provider-conventional name.
  for (const name of ["REMNIC_FIREFLIES_API_KEY", "FIREFLIES_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function createFirefliesConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  // Key resolution happens lazily at call time (not factory time) so
  // `wearables status` works without credentials and env changes take
  // effect without a restart; the client constructor throws the
  // actionable missing-key message.
  let client: FirefliesClient | null = null;
  const getClient = (): FirefliesClient => {
    if (!client) {
      client = new FirefliesClient({
        apiKey: resolveFirefliesApiKey(options.settings.apiKey) ?? "",
        baseUrl: options.settings.baseUrl,
      });
    }
    return client;
  };

  return {
    id: FIREFLIES_SOURCE_ID,
    displayName: FIREFLIES_DISPLAY_NAME,
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
      const { fromDate, toDate } = firefliesDayWindow(opts.date, opts.timezone);
      const skip = parseCursor(opts.cursor);
      const page = await getClient().listTranscripts({
        fromDate,
        toDate,
        skip,
        signal: opts.signal,
      });
      return {
        conversations: page.transcripts.map(transcriptToConversation),
        // Advance the keyset only while full pages keep coming; a partial
        // page ends the day. Guard against a runaway/looping cursor.
        nextCursor: page.hadFullPage && page.transcripts.length > 0 ? String(skip + page.transcripts.length) : null,
      };
    },
  };
}

/** Opaque cursor is the numeric `skip` offset; anything invalid restarts at 0. */
function parseCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== "string") return 0;
  const parsed = Number(cursor);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: FIREFLIES_SOURCE_ID,
  displayName: FIREFLIES_DISPLAY_NAME,
  factory: createFirefliesConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing
 * this module registers it as a side effect; calling this again is safe
 * (returns false when already registered).
 */
export function ensureFirefliesConnectorRegistered(): boolean {
  if (getWearableConnector(FIREFLIES_SOURCE_ID)) return false;
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureFirefliesConnectorRegistered();
