import { spawnSync } from "node:child_process";

import { RELAY_UNSHARE_NAMESPACE_ARGS } from "./network-gateway.js";

let cached: boolean | undefined;

/**
 * Whether this host can create the unprivileged user namespace the relay
 * isolation sandbox needs.
 *
 * The relay tests spawn `/usr/bin/unshare --user --map-root-user ...`. On hosts
 * that disallow unprivileged user namespaces — notably GitHub-hosted
 * `ubuntu-latest` runners, where `kernel.apparmor_restrict_unprivileged_userns=1`
 * — that call dies at the `/proc/self/uid_map` write with "Operation not
 * permitted", so the sandbox never starts and the isolation assertions can never
 * run. There the tests are not meaningful and must skip rather than fail.
 *
 * The probe replays the exact namespace flags the tests use against `/bin/true`,
 * so it is faithful to what the sandbox requires. The result is cached because it
 * cannot change within a process. It fails closed (returns false, i.e. skip) on
 * any error or on a non-Linux platform.
 */
export function relayUserNamespacesAvailable(): boolean {
  if (cached !== undefined) return cached;
  if (process.platform !== "linux") {
    cached = false;
    return cached;
  }
  try {
    const result = spawnSync("/usr/bin/unshare", [...RELAY_UNSHARE_NAMESPACE_ARGS, "/bin/true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    cached = result.error === undefined && result.status === 0;
  } catch {
    cached = false;
  }
  return cached;
}
