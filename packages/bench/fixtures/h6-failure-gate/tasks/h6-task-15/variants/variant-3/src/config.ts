/**
 * Default configuration options for config-server-cluster
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_config_server_cluster = {
  domain: "config-server-cluster",
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

export function getEffectiveConfig_config_server_cluster(): typeof DEFAULT_CONFIG_config_server_cluster {
  return { ...DEFAULT_CONFIG_config_server_cluster };
}
