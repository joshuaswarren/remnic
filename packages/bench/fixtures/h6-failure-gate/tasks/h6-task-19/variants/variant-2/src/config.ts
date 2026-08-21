/**
 * Default configuration options for scheduler-daemon-service
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_scheduler_daemon_service = {
  domain: "scheduler-daemon-service",
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

export function getEffectiveConfig_scheduler_daemon_service(): typeof DEFAULT_CONFIG_scheduler_daemon_service {
  return { ...DEFAULT_CONFIG_scheduler_daemon_service };
}
