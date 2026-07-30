/**
 * Default configuration options for analytics-beacon-hub
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_analytics_beacon_hub = {
  domain: "analytics-beacon-hub",
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

export function getEffectiveConfig_analytics_beacon_hub(): typeof DEFAULT_CONFIG_analytics_beacon_hub {
  return { ...DEFAULT_CONFIG_analytics_beacon_hub };
}
