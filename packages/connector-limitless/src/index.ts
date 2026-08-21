/**
 * @remnic/connector-limitless — Limitless.ai Pendant connector.
 *
 * À-la-carte optional companion of @remnic/core: installing core alone
 * never pulls this in; core discovers it at runtime via a
 * computed-specifier dynamic import (see wearables/registry.ts) or via
 * a direct import of this module, which self-registers idempotently.
 *
 * API key: `wearables.sources.limitless.apiKey`, else the
 * `REMNIC_LIMITLESS_API_KEY` / `LIMITLESS_API_KEY` environment
 * variables (checked in that order).
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

import { LimitlessClient } from "./client.js";
import { lifelogToConversation, LIMITLESS_SOURCE_ID } from "./normalize.js";

export { LimitlessClient, LimitlessApiError, LIFELOGS_MAX_PAGE_SIZE, LIMITLESS_DEFAULT_BASE_URL } from "./client.js";
export type {
  LifelogsPage,
  LimitlessClientOptions,
  LimitlessContentNode,
  LimitlessLifelog,
} from "./client.js";
export { lifelogToConversation, LIMITLESS_SOURCE_ID } from "./normalize.js";

export function resolveLimitlessApiKey(
  configuredKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configuredKey === "string" && configuredKey.trim().length > 0) {
    return configuredKey.trim();
  }
  // REMNIC_* first, then the provider-conventional name.
  for (const name of ["REMNIC_LIMITLESS_API_KEY", "LIMITLESS_API_KEY"]) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function createLimitlessConnector(
  options: WearableConnectorFactoryOptions,
): WearableSourceConnector {
  // Key resolution happens lazily at call time (not factory time) so
  // `wearables status` works without credentials and env changes take
  // effect without a restart; the client constructor throws the
  // actionable missing-key message.
  let client: LimitlessClient | null = null;
  const getClient = (): LimitlessClient => {
    if (!client) {
      client = new LimitlessClient({
        apiKey: resolveLimitlessApiKey(options.settings.apiKey) ?? "",
        baseUrl: options.settings.baseUrl,
      });
    }
    return client;
  };

  return {
    id: LIMITLESS_SOURCE_ID,
    displayName: "Limitless Pendant",
    async verifyAuth(signal?: AbortSignal) {
      return getClient().verifyAuth(signal);
    },
    async fetchConversations(
      opts: WearableFetchOptions,
    ): Promise<WearableFetchPage> {
      const page = await getClient().listLifelogs({
        date: opts.date,
        timezone: opts.timezone,
        cursor: opts.cursor,
        signal: opts.signal,
      });
      return {
        conversations: page.lifelogs.map(lifelogToConversation),
        nextCursor: page.nextCursor,
      };
    },
  };
}

export const wearableConnectorRegistration: WearableConnectorRegistration = {
  id: LIMITLESS_SOURCE_ID,
  displayName: "Limitless Pendant",
  factory: createLimitlessConnector,
};

/**
 * Idempotently register the connector with the core registry. Importing
 * this module registers it as a side effect; calling this again is safe
 * (returns false when already registered).
 */
export function ensureLimitlessConnectorRegistered(): boolean {
  if (getWearableConnector(LIMITLESS_SOURCE_ID) !== undefined) {
    return false;
  }
  registerWearableConnector(wearableConnectorRegistration);
  return true;
}

ensureLimitlessConnectorRegistered();
