/**
 * Default configuration options for quillboard-inventory-sync
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_quillboard_inventory_sync = {
  domain: "quillboard-inventory-sync",
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

export function getEffectiveConfig_quillboard_inventory_sync(): typeof DEFAULT_CONFIG_quillboard_inventory_sync {
  return { ...DEFAULT_CONFIG_quillboard_inventory_sync };
}
