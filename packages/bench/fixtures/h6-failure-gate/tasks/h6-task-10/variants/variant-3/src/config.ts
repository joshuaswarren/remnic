/**
 * Default configuration options for vector-session-store
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_vector_session_store = {
  domain: "vector-session-store",
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

export function getEffectiveConfig_vector_session_store(): typeof DEFAULT_CONFIG_vector_session_store {
  return { ...DEFAULT_CONFIG_vector_session_store };
}
