/**
 * Hand-declared surface of the host's public `openclaw/plugin-sdk/routing`
 * subpath (upstream package.json `exports`, present since 2026.3). The host
 * supplies `openclaw` as a peer dependency at runtime; it is not installed in
 * host-free dev/test environments, so this module is probed lazily by
 * `delegate-hook-fields.ts` rather than imported statically.
 */
declare module "openclaw/plugin-sdk/routing" {
  export function isSubagentSessionKey(
    sessionKey: string | undefined | null,
  ): boolean;
}
