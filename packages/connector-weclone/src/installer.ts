/**
 * WeClone connector installer.
 *
 * Generates setup instructions for connecting a WeClone avatar
 * to Remnic memory through the OpenAI-compatible proxy.
 */

import type { WeCloneConnectorConfig } from "./config.js";

export interface WeCloneInstallResult {
  config: WeCloneConnectorConfig;
  instructions: string;
}

/**
 * Generate human-readable setup instructions for the WeClone connector.
 *
 * Tells the user how to start each component and reconfigure their
 * bot to route through the memory-aware proxy.
 */
export function generateWeCloneInstructions(
  config: WeCloneConnectorConfig
): WeCloneInstallResult {
  const instructions = `
WeClone + Remnic Memory Connector Setup
========================================

Prerequisites:
  - WeClone avatar API server
  - Remnic daemon (remnic-server)
  - Node.js 18+

Steps:

1. Start the WeClone API server
   Ensure it is listening at: ${config.wecloneApiUrl}

2. Start the Remnic daemon
   Ensure it is listening at: ${config.remnicDaemonUrl}

3. Start the connector proxy
   remnic-weclone-proxy --config ~/.remnic/connectors/weclone.json

   The proxy will listen on port ${config.proxyPort} and forward
   requests to WeClone after injecting Remnic memory context.
   (All settings are read from the config file.)

4. Update your bot / client configuration
   Change the API base URL from:
     ${config.wecloneApiUrl}
   to:
     http://localhost:${config.proxyPort}/v1

   All OpenAI-compatible requests will be transparently proxied
   with memory injection for chat completions.

Session strategy: ${config.sessionStrategy}
${config.sessionStrategy === "caller-id" ? '  Set X-Caller-Id header or "user" field to scope memory per caller.' : "  All requests share a single memory session."}

Health check:
  GET http://localhost:${config.proxyPort}/health
`.trim();

  return { config, instructions };
}
