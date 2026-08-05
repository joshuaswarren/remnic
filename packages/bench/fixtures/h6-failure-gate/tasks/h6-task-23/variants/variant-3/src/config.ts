/**
 * Default configuration options for dns-resolver-cache
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_dns_resolver_cache = {
  domain: "dns-resolver-cache",
  timeout: 5000,
  maxAttempts: 3,
  retryDelayMs: 100,
  enableTracing: true,
  logLevel: "info",
  features: {
    cacheEnabled: true,
    strictValidation: true,
    telemetryEnabled: false,
    auditLogging: true,
    rateLimiting: true,
  },
};

export function getEffectiveConfig_dns_resolver_cache(): typeof DEFAULT_CONFIG_dns_resolver_cache {
  return { ...DEFAULT_CONFIG_dns_resolver_cache };
}
