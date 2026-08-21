/**
 * Default configuration options for media-transcoder-service
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_media_transcoder_service = {
  domain: "media-transcoder-service",
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

export function getEffectiveConfig_media_transcoder_service(): typeof DEFAULT_CONFIG_media_transcoder_service {
  return { ...DEFAULT_CONFIG_media_transcoder_service };
}
