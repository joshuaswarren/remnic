import { throwIfAborted } from "./abort-error.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import {
  type EngramAccessExtractionForceFlushRequest,
  type EngramAccessExtractionForceFlushResponse,
  EngramAccessInputError,
} from "./access-service.js";
import {
  resolveNamespaceCapabilities,
} from "./capabilities.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import type { AccessObserveWriteSurfaceDeps } from "./access-observe-write-surface.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import { SessionOwnershipError } from "./orchestration/session-context.js";

export async function extractionForceFlush(
  deps: AccessObserveWriteSurfaceDeps,
  request: EngramAccessExtractionForceFlushRequest,
): Promise<EngramAccessExtractionForceFlushResponse> {
  if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
    throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
  }
  if (
    request.deadlineMs !== undefined &&
    (!Number.isFinite(request.deadlineMs) || request.deadlineMs < 0)
  ) {
    throw new EngramAccessInputError("deadlineMs must be a finite non-negative number");
  }
  throwIfAborted(request.abortSignal, "extraction force-flush aborted");
  const namespacesEnabled = resolveNamespaceCapabilities(deps.orchestrator.config).namespaces === true;
  const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
  const sessionPrincipal = namespacesEnabled
    ? resolvePrincipal(request.sessionKey, deps.orchestrator.config)
    : undefined;
  const opaqueSession =
    namespacesEnabled && (sessionPrincipal === undefined || sessionPrincipal === "default");
  if (namespacesEnabled) {
    if (
      !authenticatedPrincipal ||
      (sessionPrincipal !== undefined &&
        sessionPrincipal !== "default" &&
        sessionPrincipal !== authenticatedPrincipal)
    ) {
      throw new EngramAccessInputError("sessionKey is not owned by authenticated principal");
    }
  }

  const previousCodingContext = deps.orchestrator.getCodingContextForSession(request.sessionKey);
  let seededCodingContext: unknown = null;
  const captureSeededCodingContext = (): void => {
    if (previousCodingContext !== null || seededCodingContext !== null) return;
    const currentCodingContext = deps.orchestrator.getCodingContextForSession(request.sessionKey);
    if (currentCodingContext !== null) seededCodingContext = currentCodingContext;
  };
  const clearSeededCodingContext = (): void => {
    if (previousCodingContext !== null || seededCodingContext === null) return;
    if (deps.orchestrator.getCodingContextForSession(request.sessionKey) === seededCodingContext) {
      deps.orchestrator.setCodingContextForSession(request.sessionKey, null);
    }
  };

  try {
    const scope = await deps.resolveMemoryScopePlan(request);
    captureSeededCodingContext();
    if (opaqueSession && previousCodingContext === null) {
      const scopedCodingContext = deps.orchestrator.getCodingContextForSession(request.sessionKey);
      if (scopedCodingContext !== null) {
        deps.orchestrator.setCodingContextForSession(request.sessionKey, null);
        seededCodingContext = null;
      }
    }
    throwIfAborted(request.abortSignal, "extraction force-flush aborted");
    if (typeof request.deadlineMs === "number" && request.deadlineMs <= Date.now()) {
      throw new EngramAccessInputError("extraction force-flush deadline exceeded before buffer drain");
    }

    if (!request.namespace?.trim() && !opaqueSession) {
      await deps.maybeAttachCodingContext(request.sessionKey, {
        cwd: request.cwd,
        projectTag: request.projectTag,
      });
      captureSeededCodingContext();
    }
    throwIfAborted(request.abortSignal, "extraction force-flush aborted");
    if (typeof request.deadlineMs === "number" && request.deadlineMs <= Date.now()) {
      throw new EngramAccessInputError("extraction force-flush deadline exceeded before buffer drain");
    }
    await deps.orchestrator.flushSession(request.sessionKey, {
      reason: "access_force_flush",
      abortSignal: request.abortSignal,
      failOnExtractionFailure: true,
      extractionDeadlineMs: request.deadlineMs,
      writeNamespaceOverride: scope.writeNamespace,
      principalOverride:
        typeof scope.principal === "string" && scope.principal.length > 0 ? scope.principal : undefined,
    });

    return {
      flushed: true,
      sessionKey: request.sessionKey,
      namespace: deps.legacyResponseNamespaceForScope(scope),
      effectiveNamespace: scope.writeNamespace,
    };
  } catch (error) {
    clearSeededCodingContext();
    if (error instanceof SessionOwnershipError) {
      throw new EngramAccessForbiddenError(error.message);
    }
    if (error instanceof ExtractionDeadlineError) {
      throw new EngramAccessInputError(error.message);
    }
    throw error;
  }
}
