/**
 * Default configuration options for rate-limiter-filter
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_rate_limiter_filter = {
  domain: "rate-limiter-filter",
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

export function getEffectiveConfig_rate_limiter_filter(): typeof DEFAULT_CONFIG_rate_limiter_filter {
  return { ...DEFAULT_CONFIG_rate_limiter_filter };
}
