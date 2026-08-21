/**
 * @remnic/connector-granola — Granola meeting-notes connector.
 *
 * À-la-carte optional companion of @remnic/core: installing core alone
 * never pulls this in; core discovers it at runtime via a
 * computed-specifier dynamic import (see wearables/registry.ts) or via
 * a direct import of this module, which self-registers idempotently.
 *
 * API key: `wearables.sources.granola.apiKey`, else the
 * `REMNIC_GRANOLA_API_KEY` / `GRANOLA_API_KEY` environment variables
 * (checked in that order). Create a key under Settings → Connectors →
 * API keys in the Granola app (Business/Enterprise plans).
 */

import {
  registerWearableConnector,
  getWearableConnector,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableConversation,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableSourceConnector,
} from "@remnic/core";

import { GranolaApiError, GranolaClient, type GranolaNote } from "./client.js";
import { GRANOLA_SOURCE_ID, granolaDayWindow, noteToConversation } from "./normalize.js";

export {
  GranolaClient,
  GranolaApiError,
  GRANOLA_DEFAULT_BASE_URL,
  NOTES_MAX_PAGE_SIZE,
} from "./client.js";
export type {
  GranolaNote,
  GranolaTranscriptItem,
  GranolaSpeaker,
  GranolaCalendarEvent,
  GranolaUser,
  NotesPage,
  GranolaClientOptions,
} from "./client.js";
export { GRANOLA_SOURCE_ID, granolaDayWindow, noteToConversation } from "./normalize.js";

const GRANOLA_DISPLAY_NAME = "Granola";

export function resolveGranolaApiKey(
  configuredKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configuredKey === "string" && configuredKey.trim().length > 0) {
    return configuredKey.trim();
  }
  for (const name of ["REMNIC_GRANOLA_API_KEY", "GRANOLA_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function createGranolaConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  let client: GranolaClient | null = null;
  const getClient = (): GranolaClient => {
    if (!client) {
      client = new GranolaClient({
        apiKey: resolveGranolaApiKey(options.settings.apiKey) ?? "",
        baseUrl: options.settings.baseUrl,
      });
    }
    return client;
  };

  return {
    id: GRANOLA_SOURCE_ID,
    displayName: GRANOLA_DISPLAY_NAME,
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
      const { createdAfter, createdBefore } = granolaDayWindow(opts.date, opts.timezone);
      const activeClient = getClient();
      const page = await activeClient.listNotes({
        createdAfter,
        createdBefore,
        cursor: opts.cursor,
        signal: opts.signal,
      });
      // The list returns summaries only; each note's transcript/summary/timing
      // needs a per-note fetch. Fetch sequentially to respect the 5 req/s rate
      // limit (the client also backs off on 429).
      const conversations: WearableConversation[] = [];
      for (const summary of page.notes) {
        let full: GranolaNote;
        try {
          full = await activeClient.getNote(summary.id, opts.signal);
        } catch (err) {
          // A note that 404s (deleted / no longer summarized) is gone, not a
          // backend outage — skip it. Any other failure is real; rethrow so it
          // reads as a source failure, not a quiet day (AGENTS.md §22).
          if (err instanceof GranolaApiError && err.status === 404) continue;
          throw err;
        }
        const conversation = noteToConversation(full);
        // Drop a record with no resolvable start rather than emit an empty
        // startIso that fails downstream parsing silently.
        if (conversation.startIso !== "") conversations.push(conversation);
      }
      return { conversations, nextCursor: page.nextCursor };
    },
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: GRANOLA_SOURCE_ID,
  displayName: GRANOLA_DISPLAY_NAME,
  factory: createGranolaConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing this
 * module registers it as a side effect; calling again is safe.
 */
export function ensureGranolaConnectorRegistered(): boolean {
  if (getWearableConnector(GRANOLA_SOURCE_ID)) return false;
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureGranolaConnectorRegistered();
