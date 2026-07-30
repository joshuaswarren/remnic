/**
 * Default configuration options for event-dispatcher-bus
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_event_dispatcher_bus = {
  domain: "event-dispatcher-bus",
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

export function getEffectiveConfig_event_dispatcher_bus(): typeof DEFAULT_CONFIG_event_dispatcher_bus {
  return { ...DEFAULT_CONFIG_event_dispatcher_bus };
}
