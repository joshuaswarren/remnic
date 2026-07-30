/**
 * Default configuration options for metrics-collector-agent
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_metrics_collector_agent = {
  domain: "metrics-collector-agent",
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

export function getEffectiveConfig_metrics_collector_agent(): typeof DEFAULT_CONFIG_metrics_collector_agent {
  return { ...DEFAULT_CONFIG_metrics_collector_agent };
}
