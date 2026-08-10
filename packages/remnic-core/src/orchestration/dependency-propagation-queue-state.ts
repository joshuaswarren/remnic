import { createHash } from "node:crypto";

import type { MemoryFile } from "../types.js";
import { isRecord } from "../store-contract.js";
import type { PropagationEvent } from "./dependency-propagation.js";
import type {
  DependencyPropagationJob,
  DependencyPropagationJobStatus,
} from "./dependency-propagation-delivery.js";

export const JOB_STATES: readonly DependencyPropagationJobStatus[] = [
  "prepared",
  "ready",
  "leased",
  "retryable",
  "completed",
  "dead_letter",
  "canceled",
];

const CAUSES: Record<PropagationEvent["cause"], true> = {
  contradiction: true,
  temporal_supersession: true,
  consolidation_invalidate: true,
  consolidation_merge: true,
};

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isPropagationEvent(value: unknown): value is PropagationEvent {
  if (!isRecord(value) || !isRecord(value.oldMemory)) return false;
  const oldMemory = value.oldMemory;
  if (!isRecord(oldMemory.frontmatter)) return false;
  const frontmatter = oldMemory.frontmatter;
  if (typeof oldMemory.content !== "string" || typeof frontmatter.id !== "string") return false;
  if (
    !(value.replacementId === null || typeof value.replacementId === "string") ||
    !(value.replacementContent === null || typeof value.replacementContent === "string") ||
    typeof value.namespaceScope !== "string" ||
    value.namespaceScope.length === 0 ||
    typeof value.cause !== "string" ||
    !Object.hasOwn(CAUSES, value.cause)
  ) {
    return false;
  }
  const temporalMutation = value.temporalMutation;
  if (
    temporalMutation !== undefined &&
    (!isRecord(temporalMutation) ||
      typeof temporalMutation.supersededAt !== "string" ||
      (temporalMutation.invalidAt !== undefined && typeof temporalMutation.invalidAt !== "string") ||
      !Array.isArray(temporalMutation.matchedKeys) ||
      temporalMutation.matchedKeys.some((key) => typeof key !== "string"))
  ) {
    return false;
  }
  if (frontmatter.links !== undefined) {
    if (!Array.isArray(frontmatter.links)) return false;
    for (const link of frontmatter.links) {
      if (!isRecord(link) || typeof link.targetId !== "string" || typeof link.linkType !== "string") return false;
    }
  }
  return true;
}

export function validateJob(
  value: unknown,
  expectedState?: DependencyPropagationJobStatus,
): DependencyPropagationJob | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const event = value.event;
  const attempts = value.attempts;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    typeof value.namespace !== "string" ||
    value.namespace.length === 0 ||
    typeof value.sourceId !== "string" ||
    value.sourceId.length === 0 ||
    !isPropagationEvent(event) ||
    value.jobId !== eventJobId(event) ||
    value.namespace !== event.namespaceScope ||
    value.sourceId !== event.oldMemory.frontmatter.id ||
    typeof status !== "string" ||
    !JOB_STATES.includes(status as DependencyPropagationJobStatus) ||
    (expectedState !== undefined && status !== expectedState) ||
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !isFiniteNumber(createdAt) ||
    !isFiniteNumber(updatedAt)
  ) {
    return null;
  }
  const revision = value.revision === undefined ? 0 : value.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  const reservationIdsValue = value.reservationIds;
  if (!Array.isArray(reservationIdsValue)) return null;
  const reservationIds = reservationIdsValue as unknown[];
  if (
    reservationIds.some(
      (reservationId) => typeof reservationId !== "string" || reservationId.trim().length === 0,
    ) || new Set(reservationIds).size !== reservationIds.length
  ) {
    return null;
  }
  const reservations = value.reservations;
  if (
    typeof reservations !== "number" ||
    !Number.isInteger(reservations) ||
    reservations < 0 ||
    reservations !== reservationIds.length
  ) {
    return null;
  }
  const nextAttemptAt = value.nextAttemptAt;
  const leaseOwner = value.leaseOwner;
  const leaseExpiresAt = value.leaseExpiresAt;
  const lastError = value.lastError;
  if (nextAttemptAt !== undefined && !isFiniteNumber(nextAttemptAt)) return null;
  if (leaseOwner !== undefined && typeof leaseOwner !== "string") return null;
  if (leaseExpiresAt !== undefined && !isFiniteNumber(leaseExpiresAt)) return null;
  if (lastError !== undefined && typeof lastError !== "string") return null;
  if (status === "retryable" && nextAttemptAt === undefined) return null;
  if (status === "leased" && (typeof leaseOwner !== "string" || leaseExpiresAt === undefined)) return null;
  return {
    jobId: value.jobId as string,
    namespace: value.namespace as string,
    sourceId: value.sourceId as string,
    event,
    status: status as DependencyPropagationJobStatus,
    attempts,
    createdAt,
    updatedAt,
    reservations,
    reservationIds: [...(reservationIds as string[])],
    revision,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt: nextAttemptAt as number }),
    ...(leaseOwner === undefined ? {} : { leaseOwner: leaseOwner as string }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt: leaseExpiresAt as number }),
    ...(lastError === undefined ? {} : { lastError: lastError as string }),
  };
}
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value === undefined ? null : value;
}

export function compareByteStable(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function canonicalEvent(event: PropagationEvent): PropagationEvent {
  return canonicalize(event) as PropagationEvent;
}

export function stableLinks(links: unknown): unknown {
  if (!Array.isArray(links)) return links;
  return [...links].sort((left, right) => {
    const leftKey = JSON.stringify(canonicalize(left));
    const rightKey = JSON.stringify(canonicalize(right));
    return compareByteStable(leftKey, rightKey);
  });
}

export function matchesPreparedSource(
  current: MemoryFile,
  prepared: Pick<MemoryFile, "content" | "frontmatter">,
): boolean {
  const { accessCount: _currentAccessCount, lastAccessed: _currentLastAccessed, ...currentSemantic } =
    current.frontmatter;
  const { accessCount: _preparedAccessCount, lastAccessed: _preparedLastAccessed, ...preparedSemantic } =
    prepared.frontmatter;
  const normalizedCurrent = { ...currentSemantic, links: stableLinks(currentSemantic.links) };
  const normalizedPrepared = { ...preparedSemantic, links: stableLinks(preparedSemantic.links) };
  return (
    current.content === prepared.content &&
    JSON.stringify(canonicalize(normalizedCurrent)) === JSON.stringify(canonicalize(normalizedPrepared))
  );
}

export function eventJobId(event: PropagationEvent): string {
  const { accessCount: _accessCount, lastAccessed: _lastAccessed, links, ...semanticFrontmatter } =
    event.oldMemory.frontmatter;
  const semanticEvent = {
    ...event,
    oldMemory: {
      ...event.oldMemory,
      frontmatter: { ...semanticFrontmatter, links: stableLinks(links) },
    },
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(semanticEvent))).digest("hex");
}

export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}