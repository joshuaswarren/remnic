/** Small dependency-free helpers shared across the package. */

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone. Local copy of the
 * pipeline helper — capture-screen is à-la-carte and does not depend on
 * @remnic/core.
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

/** Strip a single pair of surrounding brackets from a URL-authority IPv6 host
 *  (`[::1]` -> `::1`); non-bracketed hosts pass through unchanged. */
export function stripIpv6Brackets(host: string): string {
  const h = host.trim();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * A host is loopback when it can only be reached from this machine. Binding
 * anything else (a LAN address, 0.0.0.0, ::) exposes the daemon to the network
 * and is refused — capture-screen serves plain HTTP with no TLS contract.
 */
export function isLoopbackHost(host: string): boolean {
  return Object.hasOwn(LOOPBACK_HOSTS, stripIpv6Brackets(host).toLowerCase());
}

/** Wrap an IPv6 host in brackets for use in a URL authority; IPv4/hostnames pass through. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
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

/**
 * Operator-safe error description — name + errno code only, never foreign
 * message text or filesystem paths. This is the CLI/stderr sanitizer that
 * replaces @remnic/core's displayErrorDetail: a stack or absolute path in a
 * captured-screen daemon's stderr could leak sensitive local layout.
 */
export function sanitizeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.length > 0 ? `${err.name} (${code})` : err.name;
}
