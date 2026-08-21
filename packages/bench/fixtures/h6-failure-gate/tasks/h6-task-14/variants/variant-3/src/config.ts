/**
 * Default configuration options for identity-provider-node
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_identity_provider_node = {
  domain: "identity-provider-node",
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

export function getEffectiveConfig_identity_provider_node(): typeof DEFAULT_CONFIG_identity_provider_node {
  return { ...DEFAULT_CONFIG_identity_provider_node };
}
