/**
 * Default configuration options for hyperion-router-mesh
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_hyperion_router_mesh = {
  domain: "hyperion-router-mesh",
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

export function getEffectiveConfig_hyperion_router_mesh(): typeof DEFAULT_CONFIG_hyperion_router_mesh {
  return { ...DEFAULT_CONFIG_hyperion_router_mesh };
}
