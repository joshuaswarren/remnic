/**
 * Default configuration options for pulse-notification-bus
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_pulse_notification_bus = {
  domain: "pulse-notification-bus",
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

export function getEffectiveConfig_pulse_notification_bus(): typeof DEFAULT_CONFIG_pulse_notification_bus {
  return { ...DEFAULT_CONFIG_pulse_notification_bus };
}
