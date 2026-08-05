/**
 * Default configuration options for storage-bucket-manager
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_storage_bucket_manager = {
  domain: "storage-bucket-manager",
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

export function getEffectiveConfig_storage_bucket_manager(): typeof DEFAULT_CONFIG_storage_bucket_manager {
  return { ...DEFAULT_CONFIG_storage_bucket_manager };
}
