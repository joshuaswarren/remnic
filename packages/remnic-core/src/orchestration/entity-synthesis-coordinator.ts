/**
 * Entity synthesis coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the entity-synthesis lifecycle: processing the queued entities whose
 * evidence has changed since their last synthesis, gathering timeline +
 * structured-section evidence, deduplicating it, batch-feeding it through the
 * fast-tier LLM to produce a compact "current truth" synthesis, and persisting
 * the result with drift/bookkeeping metadata.
 *
 * Moved here (behavior-preserving):
 *   - module-level helpers `dedupeEntitySynthesisEvidenceEntries`,
 *     `flattenStructuredSectionEvidence`, `fingerprintEntitySynthesisEvidence`
 *   - the orchestrator method `processEntitySynthesisQueue`
 *
 * The orchestrator constructs one instance and delegates the public entrypoint
 * to it. Storage is resolved per-call via the injected accessor so namespace-
 * scoped and default-namespace calls share one coordinator.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps a thin delegating `processEntitySynthesisQueue` so
 * existing call sites (consolidation pass, access-service) and tests that
 * exercise the public API continue to work.
 */

import { createHash } from "node:crypto";

import type { StorageManager } from "../index.js";
import {
  compareEntityTimestamps,
  fingerprintEntityStructuredFacts,
  parseEntityFile,
} from "../storage.js";
import type {
  EntityStructuredSection,
  EntityTimelineEntry,
  PluginConfig,
} from "../types.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Evidence helpers (moved verbatim from orchestrator.ts module scope)
// ---------------------------------------------------------------------------

/**
 * Deduplicate synthesis-evidence entries by normalized text, keeping the
 * newest and oldest timestamp per unique fact when they differ.
 */
export function dedupeEntitySynthesisEvidenceEntries(
  entries: EntityTimelineEntry[],
): EntityTimelineEntry[] {
  const dedupedEvidenceEntries: EntityTimelineEntry[] = [];
  const evidenceByFact = new Map<string, {
    newest: EntityTimelineEntry;
    oldest: EntityTimelineEntry;
  }>();

  for (const entry of entries) {
    const normalizedFact = entry.text.trim();
    if (!normalizedFact) continue;
    const existing = evidenceByFact.get(normalizedFact);
    if (!existing) {
      evidenceByFact.set(normalizedFact, { newest: entry, oldest: entry });
      continue;
    }
    if (compareEntityTimestamps(entry.timestamp, existing.newest.timestamp) > 0) {
      existing.newest = entry;
    }
    if (compareEntityTimestamps(entry.timestamp, existing.oldest.timestamp) < 0) {
      existing.oldest = entry;
    }
  }

  for (const { newest, oldest } of evidenceByFact.values()) {
    dedupedEvidenceEntries.push(newest);
    const newestKey = [
      newest.timestamp,
      newest.source ?? "",
      newest.sessionKey ?? "",
      newest.principal ?? "",
      newest.text,
    ].join("\u0000");
    const oldestKey = [
      oldest.timestamp,
      oldest.source ?? "",
      oldest.sessionKey ?? "",
      oldest.principal ?? "",
      oldest.text,
    ].join("\u0000");
    if (oldestKey !== newestKey) {
      dedupedEvidenceEntries.push(oldest);
    }
  }

  return dedupedEvidenceEntries;
}

function flattenStructuredSectionEvidence(
  sections: EntityStructuredSection[] | undefined,
): EntityTimelineEntry[] {
  return (sections ?? []).flatMap((section) =>
    section.facts
      .map((fact) => fact.trim())
      .filter((fact) => fact.length > 0)
      .map((fact) => ({
        timestamp: "",
        text: fact,
        source: `section:${section.title}`,
      })),
  );
}

function fingerprintEntitySynthesisEvidence(entity: {
  timeline: EntityTimelineEntry[];
  structuredSections?: EntityStructuredSection[];
}): string {
  const fingerprint = createHash("sha256");
  const timelineEntries = entity.timeline
    .map((entry) => [
      entry.timestamp,
      entry.source ?? "",
      entry.sessionKey ?? "",
      entry.principal ?? "",
      entry.text,
    ].join("\u0000"))
    .sort();
  const timelineEntrySeparator = String.fromCharCode(1);
  const structuredFactsSeparator = String.fromCharCode(2);
  fingerprint.update(timelineEntries.join(timelineEntrySeparator));
  fingerprint.update(structuredFactsSeparator);
  fingerprint.update(fingerprintEntityStructuredFacts(entity) ?? "");
  return fingerprint.digest("hex");
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** Dependencies injected by the orchestrator. */
export interface EntitySynthesisCoordinatorDeps {
  config: PluginConfig;
  /** Resolve the storage manager for a namespace (or the default). */
  getStorage: (namespace?: string) => Promise<StorageManager>;
  /** Fast-tier LLM completion (same signature as Orchestrator.fastChatCompletion). */
  fastChatCompletion: (
    messages: Array<{ role: string; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "background" | "recall-critical";
    },
  ) => Promise<{ content: string } | null>;
}

/**
 * Coordinates entity synthesis refresh for queued entities. Owns the
 * evidence-gathering, dedup, batched-LLM-synthesis, and persistence logic
 * that previously lived inline in the orchestrator.
 */
export class EntitySynthesisCoordinator {
  constructor(private readonly deps: EntitySynthesisCoordinatorDeps) {}

  /**
   * Process up to `maxEntities` entities from the synthesis queue for the
   * given namespace. Returns the number of entities whose synthesis was
   * successfully refreshed.
   */
  async processQueue(
    namespace?: string,
    maxEntities: number = 5,
  ): Promise<number> {
    const { config } = this.deps;
    if (
      !config.entitySummaryEnabled
      || maxEntities <= 0
      || config.entitySynthesisMaxTokens <= 0
    ) return 0;
    const storage = await this.deps.getStorage(namespace);
    const queued = await storage.refreshEntitySynthesisQueue();
    let processed = 0;
    let attempted = 0;

    for (const entityName of queued) {
      if (attempted >= maxEntities) break;
      attempted += 1;
      try {
        const raw = await storage.readEntity(entityName);
        if (!raw) continue;
        const entity = parseEntityFile(raw, config.entitySchemas);
        const previousSynthesis = entity.synthesis || entity.summary || "";
        const sortedTimelineEntries = entity.timeline
          .slice()
          .sort((left, right) => compareEntityTimestamps(right.timestamp, left.timestamp));
        const newerTimelineEntries = sortedTimelineEntries.filter(
          (entry) =>
            !entity.synthesisUpdatedAt
            || compareEntityTimestamps(entry.timestamp, entity.synthesisUpdatedAt) > 0,
        );
        const appendedTimelineEntries = entity.synthesisTimelineCount === undefined
          ? []
          : entity.timeline.slice(Math.max(0, entity.synthesisTimelineCount));
        const structuredEvidenceEntries = flattenStructuredSectionEvidence(entity.structuredSections);
        const structuredEvidenceCount = structuredEvidenceEntries.length;
        const structuredEvidenceDigest = fingerprintEntityStructuredFacts(entity);
        const structuredEvidenceDrifted = structuredEvidenceDigest !== (entity.synthesisStructuredFactDigest?.trim() || undefined);
        const appendedStructuredEvidenceEntries = entity.synthesisStructuredFactCount === undefined
          || structuredEvidenceDrifted
          ? structuredEvidenceEntries
          : structuredEvidenceEntries.slice(Math.max(0, entity.synthesisStructuredFactCount));
        const candidateEvidenceEntries = [
          ...newerTimelineEntries,
          ...appendedTimelineEntries,
          ...appendedStructuredEvidenceEntries,
        ]
          .slice()
          .sort((left, right) => compareEntityTimestamps(right.timestamp, left.timestamp));
        const dedupedEvidenceEntries = dedupeEntitySynthesisEvidenceEntries(
          candidateEvidenceEntries.length > 0
            ? candidateEvidenceEntries
            : [...sortedTimelineEntries, ...structuredEvidenceEntries],
        );
        const chronologicalEvidenceEntries = dedupedEvidenceEntries
          .slice()
          .sort((left, right) => compareEntityTimestamps(left.timestamp, right.timestamp));
        if (chronologicalEvidenceEntries.length === 0) continue;
        const latestEvidenceTimestamp = chronologicalEvidenceEntries
          .slice()
          .reverse()
          .map((entry) => entry.timestamp?.trim() || undefined)
          .find((timestamp) => Boolean(timestamp));
        const previousSynthesisUpdatedAt = entity.synthesisUpdatedAt?.trim() || undefined;
        const nextSynthesisUpdatedAt = compareEntityTimestamps(
          latestEvidenceTimestamp,
          previousSynthesisUpdatedAt,
        ) >= 0
          ? latestEvidenceTimestamp
          : previousSynthesisUpdatedAt;
        const evidenceBatches: typeof chronologicalEvidenceEntries[] = [];
        for (let index = 0; index < chronologicalEvidenceEntries.length; index += 8) {
          evidenceBatches.push(chronologicalEvidenceEntries.slice(index, index + 8));
        }

        let nextSynthesis = previousSynthesis;
        let batchFailed = false;
        for (const evidenceEntries of evidenceBatches) {
          const evidenceText = evidenceEntries
            .map((entry) => {
              const sectionTitle = entry.source?.startsWith("section:")
                ? entry.source.slice("section:".length)
                : "";
              const metadata = [
                `timestamp=${entry.timestamp}`,
                sectionTitle ? `section=${sectionTitle}` : entry.source ? `source=${entry.source}` : "",
                entry.sessionKey ? `session=${entry.sessionKey}` : "",
                entry.principal ? `principal=${entry.principal}` : "",
              ]
                .filter(Boolean)
                .join(", ");
              return `- ${metadata}: ${entry.text}`;
            })
            .join("\n");
          const response = await this.deps.fastChatCompletion(
            [
              {
                role: "system",
                content:
                  "Rewrite the entity synthesis as compact current truth. Preserve uncertainty when evidence conflicts. Return plain text only.",
              },
              {
                role: "user",
                content: [
                  `Entity: ${entity.name} (${entity.type})`,
                  nextSynthesis ? `Previous synthesis:\n${nextSynthesis}` : "Previous synthesis: none",
                  `New evidence:\n${evidenceText}`,
                ].join("\n\n"),
              },
            ],
            {
              temperature: 0.2,
              maxTokens: config.entitySynthesisMaxTokens,
              operation: "entity_summary",
              priority: "background",
            },
          );
          const synthesis = response?.content?.trim().replace(/^["']|["']$/g, "");
          const maxSynthesisChars = Math.max(2_000, config.entitySynthesisMaxTokens * 8);
          if (!synthesis || synthesis.length < 10 || synthesis.length > maxSynthesisChars) {
            batchFailed = true;
            break;
          }
          nextSynthesis = synthesis;
        }
        if (batchFailed || nextSynthesis.length === 0) continue;
        const latestRaw = await storage.readEntity(entityName);
        if (!latestRaw) continue;
        const latestEntity = parseEntityFile(latestRaw, config.entitySchemas);
        if (
          fingerprintEntitySynthesisEvidence(latestEntity)
          !== fingerprintEntitySynthesisEvidence(entity)
        ) {
          continue;
        }
        await storage.updateEntitySynthesis(entityName, nextSynthesis, {
          entityUpdatedAt: new Date().toISOString(),
          synthesisStructuredFactDigest: structuredEvidenceDigest,
          synthesisStructuredFactCount: structuredEvidenceCount,
          synthesisTimelineCount: entity.timeline.length,
          updatedAt: nextSynthesisUpdatedAt,
        });
        processed += 1;
      } catch (err) {
        log.debug(`entity synthesis refresh failed for ${entityName}: ${err}`);
      }
    }

    return processed;
  }
}
