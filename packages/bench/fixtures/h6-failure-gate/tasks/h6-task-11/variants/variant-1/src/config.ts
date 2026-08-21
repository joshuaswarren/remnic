/**
 * Default configuration options for crypto-wallet-core
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_crypto_wallet_core = {
  domain: "crypto-wallet-core",
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

export function getEffectiveConfig_crypto_wallet_core(): typeof DEFAULT_CONFIG_crypto_wallet_core {
  return { ...DEFAULT_CONFIG_crypto_wallet_core };
}
