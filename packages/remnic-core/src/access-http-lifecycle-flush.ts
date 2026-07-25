import type {
  EngramAccessExtractionForceFlushRequest,
  EngramAccessLcmCompactionFlushRequest,
  EngramAccessService,
} from "./access-service.js";
import type { OperationName } from "./access-boundary.js";

export interface LifecycleFlushHttpDeps {
  service: Pick<EngramAccessService, "extractionForceFlush" | "lcmCompactionFlush">;
  enforceTokenOp(op: OperationName): void;
  readValidatedBody(
    schemaName: "lcmCompactionFlush" | "extractionForceFlush",
  ): Promise<EngramAccessLcmCompactionFlushRequest | EngramAccessExtractionForceFlushRequest>;
  ensureWriteRateLimitAvailable(): void;
  resolveNamespace(namespace: string | undefined): string | undefined;
  resolveRequestPrincipal(): string | undefined;
  recordWriteRateLimitHit(): void;
  respondJson(payload: unknown): void;
}

export async function maybeHandleLifecycleFlush(
  deps: LifecycleFlushHttpDeps,
  method: string | undefined,
  pathname: string,
  abortSignal: AbortSignal,
): Promise<boolean> {
  if (method !== "POST") return false;
  if (
    pathname === "/engram/v1/lcm/compaction/flush" ||
    pathname === "/remnic/v1/lcm/compaction/flush"
  ) {
    deps.enforceTokenOp("lcm_compaction_flush");
    const body = await deps.readValidatedBody("lcmCompactionFlush");
    deps.ensureWriteRateLimitAvailable();
    const response = await deps.service.lcmCompactionFlush({
      ...body,
      namespace: deps.resolveNamespace(body.namespace),
      authenticatedPrincipal: deps.resolveRequestPrincipal(),
    });
    deps.recordWriteRateLimitHit();
    deps.respondJson(response);
    return true;
  }

  if (
    pathname === "/engram/v1/extraction/flush" ||
    pathname === "/remnic/v1/extraction/flush"
  ) {
    deps.enforceTokenOp("extraction_force_flush");
    const body = await deps.readValidatedBody("extractionForceFlush");
    deps.ensureWriteRateLimitAvailable();
    const response = await deps.service.extractionForceFlush({
      ...body,
      namespace: deps.resolveNamespace(body.namespace),
      authenticatedPrincipal: deps.resolveRequestPrincipal(),
      abortSignal,
    });
    deps.recordWriteRateLimitHit();
    deps.respondJson(response);
    return true;
  }

  return false;
}
