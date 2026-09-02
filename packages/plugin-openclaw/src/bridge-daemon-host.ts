/**
 * Daemon host classification for the bridge: which addresses name THIS
 * machine, and how a same-host daemon is dialed.
 *
 * Split from `bridge.ts`, which owns endpoint discovery and probing.
 */

import { isIP, isIPv6 } from "node:net";
import os from "node:os";
import { isLoopbackHost } from "@remnic/core/runtime/http-transport.js";

const LOOPBACK_V4 = "127.0.0.1";

/**
 * Whether a daemon endpoint names THIS host.
 *
 * Address classification is the shared core helper (`isLoopbackHost`), so
 * `0:0:0:0:0:0:0:1`, `::1`, `::ffff:127.0.0.1`, and `127.x` all resolve
 * alike here and everywhere else — comparing raw strings would leave `auto`
 * embedded beside a reachable same-host daemon just because its config
 * spelled the address differently.
 *
 * A wildcard bind or an address assigned to one of this host's interfaces
 * names every interface on this host, so it counts as local —
 * `server.host: "0.0.0.0"` is the documented daemon configuration.
 */
export function isLoopbackDaemonHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (loopbackForSameHost(normalized) !== undefined) return true;
  return isLoopbackHost(normalized);
}

/**
 * Collapse an IPv6 literal to its canonical form, or `undefined` when the
 * string is not one. Node's `net.isIPv6` validates; `URL` canonicalizes.
 */
function canonicalIPv6(value: string): string | undefined {
  if (!isIPv6(value)) return undefined;
  try {
    // The URL parser applies RFC 5952 compression and lowercasing.
    return new URL(`http://[${value}]`).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return value;
  }
}

/**
 * The loopback address a same-host daemon is dialed on, or `undefined` for a
 * host that is not provably this machine.
 *
 * A wildcard bind names every interface on THIS host, not a remote one. The
 * documented `server.host: "0.0.0.0"` daemon config would otherwise be
 * classified as remote — leaving `auto` embedded beside a same-host daemon on
 * the same corpus — and is not a portable destination address either, so it is
 * dialed through the matching loopback.
 *
 * An address assigned to one of this host's own interfaces (a NIC or a VIP the
 * operator exported as `REMNIC_HOST`) is the same case: it names the daemon
 * loopback reaches, and a gateway fetch to such an address has been observed to
 * hang on the connect while loopback answers at once.
 */
export function loopbackForSameHost(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "0.0.0.0") return LOOPBACK_V4;
  const v6 = canonicalIPv6(normalized);
  if (v6 === "::") return "::1";
  if (isLocalInterfaceAddress(v6 ?? normalized)) return v6 === undefined ? LOOPBACK_V4 : "::1";
  return undefined;
}

/**
 * The configured address to retry when a same-host loopback dial fails. Only
 * an interface address qualifies — a wildcard bind is not dialable, and a
 * daemon bound to exactly one interface address answers no loopback dial.
 */
export function sameHostDialFallback(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return isLocalInterfaceAddress(canonicalIPv6(normalized) ?? normalized) ? normalized : undefined;
}

function isLocalInterfaceAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const assigned = entry.family === "IPv6" ? canonicalIPv6(entry.address.replace(/%.*$/, "")) : entry.address;
      if (assigned === address) return true;
    }
  }
  return false;
}

export function normalizeDaemonHost(value: string): string {
  const match = value.trim().match(/^\[(.+)\]$/);
  return match ? match[1] : value.trim();
}
