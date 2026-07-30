/**
 * Default configuration options for load-balancer-proxy
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_load_balancer_proxy = {
  domain: "load-balancer-proxy",
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

export function getEffectiveConfig_load_balancer_proxy(): typeof DEFAULT_CONFIG_load_balancer_proxy {
  return { ...DEFAULT_CONFIG_load_balancer_proxy };
}
