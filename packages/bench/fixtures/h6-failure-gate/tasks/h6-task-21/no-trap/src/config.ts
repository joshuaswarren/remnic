/**
 * Default configuration options for feature-flag-service
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_feature_flag_service = {
  domain: "feature-flag-service",
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

export function getEffectiveConfig_feature_flag_service(): typeof DEFAULT_CONFIG_feature_flag_service {
  return { ...DEFAULT_CONFIG_feature_flag_service };
}
