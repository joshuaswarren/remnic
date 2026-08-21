/**
 * @remnic/connector-bee — Bee wearable connector.
 *
 * À-la-carte optional companion of @remnic/core (computed-specifier
 * discovery; importing this module self-registers idempotently).
 *
 * Access modes:
 *  - default: the local `bee proxy` (http://127.0.0.1:8787, no token)
 *  - direct:  set `wearables.sources.bee.baseUrl` to the direct host
 *             and provide a token via `REMNIC_BEE_API_TOKEN` /
 *             `BEE_API_TOKEN` (or `apiKey` in config)
 *
 * Bee's list API has no date filter, so the connector paginates
 * newest-first and filters conversations to the requested local day,
 * stopping once a whole page predates it.
 */

import {
  dateInTimezone,
  registerWearableConnector,
  getWearableConnector,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
  type WearableFetchOptions,
  type WearableFetchPage,
  type WearableNativeMemoryPage,
  type WearableSourceConnector,
} from "@remnic/core";

import { BeeClient, isLocalProxyUrl, BEE_DEFAULT_BASE_URL, type BeeConversationListItem } from "./client.js";
import { BEE_SOURCE_ID, conversationToWearable, factToNativeMemory } from "./normalize.js";

export {
  BeeApiError,
  BeeClient,
  BEE_DEFAULT_BASE_URL,
  BEE_DIRECT_BASE_URL,
  isLocalProxyUrl,
} from "./client.js";
export type {
  BeeClientOptions,
  BeeConversationDetail,
  BeeConversationListItem,
  BeeConversationsPage,
  BeeFact,
  BeeFactsPage,
  BeeUtterance,
} from "./client.js";
export { BEE_SOURCE_ID, conversationToWearable, factToNativeMemory } from "./normalize.js";

export function resolveBeeToken(
  configuredToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configuredToken === "string" && configuredToken.trim().length > 0) {
    return configuredToken.trim();
  }
  for (const name of ["REMNIC_BEE_API_TOKEN", "BEE_API_TOKEN"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Conversations still being recorded are skipped until they settle. */
function isSyncableState(item: BeeConversationListItem): boolean {
  return typeof item.state !== "string" || item.state.toUpperCase() !== "CAPTURING";
}

export function createBeeConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  let client: BeeClient | null = null;
  const getClient = (): BeeClient => {
    if (!client) {
      const baseUrl = options.settings.baseUrl ?? BEE_DEFAULT_BASE_URL;
      // The local proxy is unauthenticated by design — never attach a
      // Bearer header there, even when a direct-mode token sits in the
      // environment (it would 401 proxy requests for users who keep
      // BEE_API_TOKEN exported for occasional direct use).
      const token = isLocalProxyUrl(baseUrl)
        ? undefined
        : resolveBeeToken(options.settings.apiKey);
      client = new BeeClient({ token, baseUrl });
    }
    return client;
  };

  return {
    id: BEE_SOURCE_ID,
    displayName: "Bee",
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage> {
      const page = await getClient().listConversations({
        cursor: opts.cursor,
        signal: opts.signal,
      });

      const matching: BeeConversationListItem[] = [];
      let sawOnlyOlder = page.conversations.length > 0;
      for (const item of page.conversations) {
        const localDate = dateInTimezone(new Date(item.start_time), opts.timezone);
        if (localDate === opts.date && isSyncableState(item)) {
          matching.push(item);
        }
        if (localDate >= opts.date) {
          sawOnlyOlder = false;
        }
      }

      const conversations = [];
      for (const item of matching) {
        const detail = await getClient().getConversation(item.id, opts.signal);
        if (detail === null) continue;
        conversations.push(conversationToWearable(detail));
      }

      // Stop paginating once an entire (newest-first) page predates the
      // requested day; anything deeper is older still.
      const nextCursor = sawOnlyOlder ? null : page.nextCursor;
      return { conversations, nextCursor };
    },
    async fetchNativeMemories(opts: {
      cursor?: string | null;
      signal?: AbortSignal;
    }): Promise<WearableNativeMemoryPage> {
      const page = await getClient().listFacts({
        cursor: opts.cursor,
        signal: opts.signal,
      });
      return {
        memories: page.facts.map(factToNativeMemory),
        nextCursor: page.nextCursor,
      };
    },
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: BEE_SOURCE_ID,
  displayName: "Bee",
  factory: createBeeConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing
 * this module registers it as a side effect; calling this again is safe
 * (returns false when already registered).
 */
export function ensureBeeConnectorRegistered(): boolean {
  if (getWearableConnector(BEE_SOURCE_ID) !== undefined) {
    return false;
  }
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureBeeConnectorRegistered();
