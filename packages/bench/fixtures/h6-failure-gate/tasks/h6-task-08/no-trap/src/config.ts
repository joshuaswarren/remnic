/**
 * Default configuration options for quantum-order-pipeline
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_quantum_order_pipeline = {
  domain: "quantum-order-pipeline",
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

export function getEffectiveConfig_quantum_order_pipeline(): typeof DEFAULT_CONFIG_quantum_order_pipeline {
  return { ...DEFAULT_CONFIG_quantum_order_pipeline };
}
