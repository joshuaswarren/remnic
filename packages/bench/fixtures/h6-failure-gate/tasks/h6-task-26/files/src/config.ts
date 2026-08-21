/**
 * Default configuration options for queue-worker-daemon
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_queue_worker_daemon = {
  domain: "queue-worker-daemon",
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

export function getEffectiveConfig_queue_worker_daemon(): typeof DEFAULT_CONFIG_queue_worker_daemon {
  return { ...DEFAULT_CONFIG_queue_worker_daemon };
}
