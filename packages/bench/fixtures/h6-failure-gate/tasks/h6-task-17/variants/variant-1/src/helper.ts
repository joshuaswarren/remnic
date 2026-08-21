/**
 * Helper routines for workflow-runner-engine
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_workflow_runner_engine, generateTraceId_workflow_runner_engine } from "./utils.js";

export function getDomainHeader_workflow_runner_engine_revision(domain: string): string {
  return "X-Domain-" + formatDomainName_workflow_runner_engine(domain);
}

export function createServiceContext_workflow_runner_engine_revision(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_workflow_runner_engine(domain),
    traceId: generateTraceId_workflow_runner_engine(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_workflow_runner_engine_revision(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_workflow_runner_engine<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
