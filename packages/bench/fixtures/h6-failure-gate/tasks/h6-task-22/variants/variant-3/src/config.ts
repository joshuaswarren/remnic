/**
 * Default configuration options for audit-logger-stream
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_audit_logger_stream = {
  domain: "audit-logger-stream",
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

export function getEffectiveConfig_audit_logger_stream(): typeof DEFAULT_CONFIG_audit_logger_stream {
  return { ...DEFAULT_CONFIG_audit_logger_stream };
}
