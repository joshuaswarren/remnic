/**
 * Default configuration options for secret-manager-vault
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_secret_manager_vault = {
  domain: "secret-manager-vault",
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

export function getEffectiveConfig_secret_manager_vault(): typeof DEFAULT_CONFIG_secret_manager_vault {
  return { ...DEFAULT_CONFIG_secret_manager_vault };
}
