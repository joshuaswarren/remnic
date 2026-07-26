import type {
  EngramAccessExtractionForceFlushRequest,
  EngramAccessLcmCompactionFlushRequest,
  EngramAccessService,
} from "./access-service.js";
import type { OperationName } from "./access-boundary.js";
import type { LcmCompactionFlushRequest } from "./access-schema.js";

export interface LifecycleFlushHttpDeps {
  service: Pick<EngramAccessService, "extractionForceFlush" | "lcmCompactionFlush">;
  enforceTokenOp(op: OperationName): void;
  handleLcmCompactionFlushHttp?(body: LcmCompactionFlushRequest): Promise<void>;
  readValidatedBody(schemaName: "lcmCompactionFlush"): Promise<LcmCompactionFlushRequest>;
  readValidatedBody(schemaName: "extractionForceFlush"): Promise<EngramAccessExtractionForceFlushRequest>;
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
    if (deps.handleLcmCompactionFlushHttp !== undefined) {
      await deps.handleLcmCompactionFlushHttp(body);
      return true;
    }
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
    let writeRateLimitRecorded = false;
    const recordCommittedWrite = (): void => {
      if (writeRateLimitRecorded) return;
      writeRateLimitRecorded = true;
      deps.recordWriteRateLimitHit();
    };
    const response = await deps.service.extractionForceFlush({
      ...body,
      namespace: deps.resolveNamespace(body.namespace),
      authenticatedPrincipal: deps.resolveRequestPrincipal(),
      abortSignal,
      onCommitted: recordCommittedWrite,
    });
    recordCommittedWrite();
    deps.respondJson(response);
    return true;
  }

  return false;
}
