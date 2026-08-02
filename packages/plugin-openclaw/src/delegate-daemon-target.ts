/**
 * The daemon endpoint delegate requests dial, and how each one authenticates.
 *
 * Split from `delegate-runtime.ts` because credential resolution is a policy
 * of its own: WHICH source outranks which, and which of them must be re-read
 * per request rather than frozen at detection time.
 */

import {
  loadDaemonAuth,
  readDaemonConfigAuthToken,
  readUnitAuthToken,
  type BridgeConfig,
  type DelegateDaemonTarget,
} from "./bridge.js";

/**
 * Bind a resolved bridge to its endpoint and credential.
 *
 * The credential is bound to the config or unit the resolved endpoint came
 * from, so a deployment with two daemons sends each its OWN token instead of
 * whichever one discovery happened to read first — and every source is
 * re-read per request, because a token rotated behind a daemon restart must
 * not 401 every delegated route until the gateway restarts too.
 */
export function daemonTargetFor(bridge: BridgeConfig): DelegateDaemonTarget {
  return {
    host: bridge.daemonHost,
    port: bridge.daemonPort,
    resolveAuthToken: () => {
      if (bridge.daemonAuthTokenOverride !== undefined) {
        // A unit-supplied credential is re-read from its unit — including its
        // drop-ins and `EnvironmentFile=`. A unit that has become unreadable
        // falls back to the value the probe authenticated with, rather than
        // dropping the credential entirely.
        const unitToken =
          bridge.daemonAuthUnit === undefined ? undefined : readUnitAuthToken(bridge.daemonAuthUnit);
        return {
          token: unitToken ?? bridge.daemonAuthTokenOverride,
          source: "daemon configuration",
        };
      }
      if (bridge.daemonAuthPrefersConfig && bridge.daemonConfigPath !== undefined) {
        const configToken = readDaemonConfigAuthToken(bridge.daemonConfigPath);
        if (configToken !== undefined) {
          return { token: configToken, source: "daemon configuration" };
        }
      }
      return loadDaemonAuth(bridge.daemonConfigPath);
    },
  };
}
