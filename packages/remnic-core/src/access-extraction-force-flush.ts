import { isAbortError, throwIfAborted } from "./abort-error.js";
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
import { log } from "./logger.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import { SessionOwnershipError, awaitSessionFlushPhase } from "./orchestration/session-context.js";

type PendingObserveExtractionWaiter = (
  sessionKey: string,
  principal: string | undefined,
  namespace: string | undefined,
  abortSignal?: AbortSignal,
  registerCancellation?: (cancel: () => void) => void,
) => Promise<void>;

export async function extractionForceFlush(
  deps: AccessObserveWriteSurfaceDeps,
  request: EngramAccessExtractionForceFlushRequest,
  waitForPendingObserveExtraction?: PendingObserveExtractionWaiter,
): Promise<EngramAccessExtractionForceFlushResponse> {
  if (
    !request.sessionKey ||
    typeof request.sessionKey !== "string" ||
    request.sessionKey.trim().length === 0
  ) {
    throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
  }
  if (
    request.deadlineMs !== undefined &&
    (!Number.isFinite(request.deadlineMs) || request.deadlineMs < 0)
  ) {
    throw new EngramAccessInputError("deadlineMs must be a finite non-negative number");
  }

  const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
  const cancelPendingObserveExtractions = (): void => {
    deps.cancelPendingObserveExtractions?.(
      request.sessionKey,
      authenticatedPrincipal,
    );
  };
  if (request.abortSignal?.aborted) cancelPendingObserveExtractions();
  throwIfAborted(request.abortSignal, "extraction force-flush aborted");

  const namespacesEnabled = resolveNamespaceCapabilities(deps.orchestrator.config).namespaces === true;
  const sessionPrincipal = namespacesEnabled
    ? resolvePrincipal(request.sessionKey, deps.orchestrator.config)
    : undefined;
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

  let committed = false;
  const markCommitted = (): void => {
    if (committed) return;
    committed = true;
    request.onCommitted?.();
  };
  const abortHandler = (): void => cancelPendingObserveExtractions();
  request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const scope = await deps.resolveMemoryScopePlan(request);
    throwIfAborted(request.abortSignal, "extraction force-flush aborted");
    if (typeof request.deadlineMs === "number" && request.deadlineMs <= Date.now()) {
      cancelPendingObserveExtractions();
      throw new EngramAccessInputError("extraction force-flush deadline exceeded before buffer drain");
    }

    const cancelScopedPendingObserveExtractions = (): void => {
      deps.cancelPendingObserveExtractions?.(
        request.sessionKey,
        scope.principal,
        scope.writeNamespace,
      );
    };
    await awaitSessionFlushPhase(
      () =>
        deps.orchestrator.flushSession(request.sessionKey, {
          reason: "access_force_flush",
          abortSignal: request.abortSignal,
          failOnExtractionFailure: true,
          extractionDeadlineMs: request.deadlineMs,
          writeNamespaceOverride: scope.writeNamespace,
          principalOverride:
            typeof scope.principal === "string" && scope.principal.length > 0
              ? scope.principal
              : undefined,
          scopeProfileWritePlan: scope.scopeProfilePlan,
          onCommitted: markCommitted,
        }),
      {
        abortSignal: request.abortSignal,
        extractionDeadlineMs: request.deadlineMs,
        reason: "access_force_flush",
        deadlineStage: "buffer_drain",
        onDeadline: cancelScopedPendingObserveExtractions,
      },
    );
    // A flush with no buffered turns still consumes the lifecycle write;
    // durable drains already invoked this idempotent callback.
    markCommitted();

    if (waitForPendingObserveExtraction) {
      let cancelPendingObserveExtraction: (() => void) | undefined;
      await awaitSessionFlushPhase(
        () =>
          waitForPendingObserveExtraction(
            request.sessionKey,
            scope.principal,
            scope.writeNamespace,
            request.abortSignal,
            (cancel) => {
              cancelPendingObserveExtraction = cancel;
            },
          ),
        {
          abortSignal: request.abortSignal,
          extractionDeadlineMs: request.deadlineMs,
          reason: "access_force_flush",
          deadlineStage: "pending_observe_extraction",
          onDeadline: () => {
            cancelScopedPendingObserveExtractions();
            cancelPendingObserveExtraction?.();
          },
        },
      );
    }

    const buffer = deps.orchestrator.buffer;
    if (buffer && typeof buffer.clearRetainedTurnsForSession === "function") {
      try {
        await awaitSessionFlushPhase(
          () =>
            buffer.clearRetainedTurnsForSession(
              request.sessionKey,
              namespacesEnabled ? scope.principal : undefined,
              {
                abortSignal: request.abortSignal,
                deadlineMs: request.deadlineMs,
              },
            ),
          {
            abortSignal: request.abortSignal,
            extractionDeadlineMs: request.deadlineMs,
            reason: "access_force_flush",
            deadlineStage: "retained_turn_cleanup",
          },
        );
      } catch (cleanupError) {
        if (isAbortError(cleanupError) || cleanupError instanceof ExtractionDeadlineError) {
          throw cleanupError;
        }
        log.warn(
          `extractionForceFlush: retained-turn cleanup failed after a successful flush, continuing: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
    }

    return {
      flushed: true,
      sessionKey: request.sessionKey,
      namespace: deps.legacyResponseNamespaceForScope(scope),
      effectiveNamespace: scope.writeNamespace,
    };
  } catch (error) {
    if (error instanceof SessionOwnershipError) {
      throw new EngramAccessForbiddenError(error.message);
    }
    if (error instanceof ExtractionDeadlineError) {
      throw new EngramAccessInputError(error.message);
    }
    throw error;
  } finally {
    request.abortSignal?.removeEventListener("abort", abortHandler);
  }
}
