/**
 * @remnic/connector-omi — Omi AI wearable connector.
 *
 * À-la-carte optional companion of @remnic/core (computed-specifier
 * discovery; importing this module self-registers idempotently).
 *
 * Requires an Omi integration app with the External Integration
 * `read_conversations` (and, for native-memory import,
 * `read_memories`) capabilities:
 *   - `wearables.sources.omi.appId`  — the app id
 *   - `wearables.sources.omi.userId` — the target uid
 *   - key via `REMNIC_OMI_API_KEY` / `OMI_API_KEY` env (or `apiKey`)
 */

import {
  registerWearableConnector,
  getWearableConnector,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableNativeMemoryPage,
  type WearableSourceConnector,
} from "@remnic/core";

import { OmiClient } from "./client.js";
import {
  conversationToWearable,
  memoryToNativeMemory,
  OMI_SOURCE_ID,
  zonedDayBounds,
} from "./normalize.js";

export { OmiApiError, OmiClient, OMI_DEFAULT_BASE_URL } from "./client.js";
export type {
  OmiClientOptions,
  OmiConversation,
  OmiConversationsPage,
  OmiMemoriesPage,
  OmiMemory,
  OmiTranscriptSegment,
} from "./client.js";
export {
  conversationToWearable,
  memoryToNativeMemory,
  nextIsoDate,
  OMI_SOURCE_ID,
  timezoneOffsetIso,
  zonedDayBounds,
  zonedDayStartIso,
} from "./normalize.js";

export function resolveOmiApiKey(
  configuredKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configuredKey === "string" && configuredKey.trim().length > 0) {
    return configuredKey.trim();
  }
  for (const name of ["REMNIC_OMI_API_KEY", "OMI_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseOffsetCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0;
  const parsed = Number(cursor);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function createOmiConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  // Construction is lazy so `wearables status` works without
  // credentials; the client constructor throws the actionable
  // missing-credential messages at call time.
  let client: OmiClient | null = null;
  const getClient = (): OmiClient => {
    if (!client) {
      client = new OmiClient({
        apiKey: resolveOmiApiKey(options.settings.apiKey) ?? "",
        appId: options.settings.appId ?? "",
        userId: options.settings.userId ?? "",
        baseUrl: options.settings.baseUrl,
      });
    }
    return client;
  };

  return {
    id: OMI_SOURCE_ID,
    displayName: "Omi",
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
      const bounds = zonedDayBounds(opts.date, opts.timezone);
      const page = await getClient().listConversations({
        startIso: bounds.startIso,
        endIso: bounds.endIso,
        offset: parseOffsetCursor(opts.cursor),
        signal: opts.signal,
      });
      return {
        conversations: page.conversations
          .filter((conversation) => conversation.discarded !== true)
          .map(conversationToWearable),
        nextCursor: page.nextOffset !== null ? String(page.nextOffset) : null,
      };
    },
    async fetchNativeMemories(opts: {
      cursor?: string | null;
      signal?: AbortSignal;
    }): Promise<WearableNativeMemoryPage> {
      const page = await getClient().listMemories({
        offset: parseOffsetCursor(opts.cursor),
        signal: opts.signal,
      });
      const memories = [];
      for (const memory of page.memories) {
        const mapped = memoryToNativeMemory(memory);
        if (mapped !== null) memories.push(mapped);
      }
      return {
        memories,
        nextCursor: page.nextOffset !== null ? String(page.nextOffset) : null,
      };
    },
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: OMI_SOURCE_ID,
  displayName: "Omi",
  factory: createOmiConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing
 * this module registers it as a side effect; calling this again is safe
 * (returns false when already registered).
 */
export function ensureOmiConnectorRegistered(): boolean {
  if (getWearableConnector(OMI_SOURCE_ID) !== undefined) {
    return false;
  }
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureOmiConnectorRegistered();
