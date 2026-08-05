/**
 * Default configuration options for apex-payment-gateway
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_apex_payment_gateway = {
  domain: "apex-payment-gateway",
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

export function getEffectiveConfig_apex_payment_gateway(): typeof DEFAULT_CONFIG_apex_payment_gateway {
  return { ...DEFAULT_CONFIG_apex_payment_gateway };
}
