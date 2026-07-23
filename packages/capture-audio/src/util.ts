/** Small dependency-free helpers shared across the package. */

import { randomFillSync } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Monotonic-enough ULID. 48-bit millisecond time in the leading 10
 * characters, 80 bits of randomness in the trailing 16. Uniqueness comes
 * from the random tail; the time prefix keeps ids lexically sortable so
 * `conv_<ulid>` keyset pagination orders by creation time for free.
 */
export function ulid(time: number = Date.now()): string {
  return encodeTime(time) + encodeRandom();
}

function encodeTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) {
    throw new Error("ulid: time must be a non-negative finite number");
  }
  let out = "";
  let t = Math.floor(time);
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone. Local copy of
 * the wearables-pipeline helper — capture-audio is à-la-carte and does
 * not depend on @remnic/core (that dependency arrives with the connector
 * in a later checklist item).
 */
export function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  "::1": true,
  localhost: true,
  "::ffff:127.0.0.1": true,
};

/**
 * A host is loopback when it can only be reached from this machine.
 * Binding anything else (a LAN address, 0.0.0.0, ::) exposes the daemon
 * to the network and REQUIRES bearer-token auth on every request.
 */
/** Strip a single pair of surrounding brackets from a URL-authority IPv6 host
 *  (`[::1]` -> `::1`); non-bracketed hosts pass through unchanged. */
export function stripIpv6Brackets(host: string): string {
  const h = host.trim();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function isLoopbackHost(host: string): boolean {
  return Object.hasOwn(LOOPBACK_HOSTS, stripIpv6Brackets(host).toLowerCase());
}

/** Compact, credential-free description of an unexpected value for messages. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t === "string") return `a string`;
  if (t === "object") return "an object";
  return `${t} (${String(value)})`;
}

/** Wrap an IPv6 host in brackets for use in a URL authority; IPv4/hostnames pass through. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
