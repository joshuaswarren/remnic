/**
 * Default configuration options for schema-registry-store
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_schema_registry_store = {
  domain: "schema-registry-store",
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

export function getEffectiveConfig_schema_registry_store(): typeof DEFAULT_CONFIG_schema_registry_store {
  return { ...DEFAULT_CONFIG_schema_registry_store };
}
