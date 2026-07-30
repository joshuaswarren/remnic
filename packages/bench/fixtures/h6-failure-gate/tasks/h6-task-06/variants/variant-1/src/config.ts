/**
 * Default configuration options for cyber-telemetry-stream
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_cyber_telemetry_stream = {
  domain: "cyber-telemetry-stream",
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

export function getEffectiveConfig_cyber_telemetry_stream(): typeof DEFAULT_CONFIG_cyber_telemetry_stream {
  return { ...DEFAULT_CONFIG_cyber_telemetry_stream };
}
