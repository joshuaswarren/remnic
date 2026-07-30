/**
 * Default configuration options for workflow-runner-engine
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_workflow_runner_engine = {
  domain: "workflow-runner-engine",
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

export function getEffectiveConfig_workflow_runner_engine(): typeof DEFAULT_CONFIG_workflow_runner_engine {
  return { ...DEFAULT_CONFIG_workflow_runner_engine };
}
