/**
 * Episodic-context recall section (issue #2331, harmonic-memory P3).
 *
 * Extracted sibling of `recallInternal`'s final assembly phase: resolves the
 * structured `sources` provenance of the top recalled facts to LCM archive
 * turn ranges, groups overlapping ranges into episodes, and appends the raw
 * turns as a `## Source Episodes` section — pure lookup + formatting, no LLM
 * calls, read-only archive access, inside the enrichment deadline.
 *
 * Opt-in: the registry entry is gated on `episodicContextEnabled === true`
 * (default off), so flag-off returns before touching the archive and recall
 * output stays byte-identical.
 */

import { lcmSessionKeyForNamespace } from "../coding/coding-namespace.js";
import { type EpisodicFactInput, planEpisodeWindowsWithFallback } from "../episodic-context.js";
import type { LcmMessage } from "../lcm/archive.js";
import { log } from "../logger.js";
import {
  type RecallSectionMetric,
  resolveRecallCoreSectionDeadlineMs,
  runRecallSectionWithinDeadline,
} from "../recall-qos.js";
import { cleanArchivedUserMessage } from "../user-message-cleaning.js";
import type { RecallSectionBuckets } from "./recall-section-coordinator.js";
import type { RecallInternalDeps } from "./recall-internal-deps.js";
import type { ScopePlan } from "../scopes/scope-plan.js";

/** Cap on recalled facts whose provenance is read per recall. */
const EPISODIC_FACT_SCAN_LIMIT = 8;
/** Per-turn character cap inside a Source Episodes block. */
const EPISODIC_TURN_CHAR_LIMIT = 300;

export async function appendEpisodicContextSection(
  deps: RecallInternalDeps,
  options: {
    sectionBuckets: RecallSectionBuckets;
    recalledMemoryPaths: string[];
    recalledMemoryNamespaces: Array<string | undefined>;
    scopePlan: ScopePlan;
    namespacesEnabled: boolean;
    enrichmentSectionDeadlineMs: number;
    recallOuterTimeoutMs: number;
    recallStart: number;
    abortSignal?: AbortSignal;
    recordMetric: (metric: RecallSectionMetric) => void;
  },
): Promise<void> {
  const engine = deps.lcmEngine;
  if (!engine?.enabled) return;
  if (!deps.isRecallSectionEnabled("episodic-context", false)) return;
  const maxEpisodes =
    deps.getRecallSectionNumber("episodic-context", "maxResults") ?? 2;
  const maxTurns = deps.getRecallSectionNumber("episodic-context", "maxTurns") ?? 8;
  const skip = (timing: string) =>
    options.recordMetric({
      section: "episodicContext",
      priority: "enrichment",
      durationMs: 0,
      deadlineMs: options.enrichmentSectionDeadlineMs,
      source: "skip",
      success: true,
      timing,
    });
  if (maxEpisodes <= 0 || maxTurns <= 0) {
    // Zero semantics (checklist item 33): disable before any archive query.
    skip("skip(limit=0)");
    return;
  }
  if (options.recalledMemoryPaths.length === 0) {
    skip("skip(no-memories)");
    return;
  }

  const outerDeadlineAtMs =
    options.recallOuterTimeoutMs > 0
      ? options.recallStart + options.recallOuterTimeoutMs
      : null;
  const remainingOuterMs =
    outerDeadlineAtMs === null ? null : outerDeadlineAtMs - deps.recallAssemblyClockMs();
  const deadlineMs = resolveRecallCoreSectionDeadlineMs({
    configuredCoreDeadlineMs: options.enrichmentSectionDeadlineMs,
    remainingOuterMs,
  });

  const outcome = await runRecallSectionWithinDeadline<string | null>({
    deadlineMs,
    fallback: null,
    parentSignal: options.abortSignal,
    run: async (signal) => {
      // 1. Structured provenance from the top recalled facts. Facts whose
      // frontmatter carries no `sources` array are silently skipped (no
      // legacy scalar `source` parsing — issue non-goal).
      const facts: EpisodicFactInput[] = [];
      const scanLimit = Math.min(
        options.recalledMemoryPaths.length,
        EPISODIC_FACT_SCAN_LIMIT,
      );
      for (let index = 0; index < scanLimit; index += 1) {
        const memoryPath = options.recalledMemoryPaths[index]!;
        const namespace = options.recalledMemoryNamespaces[index];
        try {
          const storage = await deps.storageRouter.storageFor(
            namespace ?? deps.config.defaultNamespace,
          );
          const memory = await storage.readMemoryByPath(memoryPath);
          const sources = memory?.frontmatter?.sources;
          if (memory && Array.isArray(sources) && sources.length > 0) {
            facts.push({
              memoryId: memory.frontmatter.id,
              rank: index,
              sources,
            });
          }
        } catch (err) {
          log.debug(
            `episodic-context: provenance read failed for ${memoryPath}`,
            err,
          );
        }
      }
      if (facts.length === 0) return null;

      // 2. Authoritative LCM session ids for a provenance sessionKey
      // (checklist item 30): only keys framed under the caller's authorized read
      // namespaces. A foreign session's rows live under a foreign namespace
      // frame and are unreachable through this mapping.
      const readNamespaces = options.namespacesEnabled
        ? options.scopePlan.lcmReadNamespaces
        : [deps.config.defaultNamespace];
      const candidateSessionIds = (sessionKey: string): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const namespace of readNamespaces) {
          const key =
            lcmSessionKeyForNamespace(
              namespace,
              sessionKey,
              deps.config.defaultNamespace,
            ) ?? sessionKey;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(key);
          }
        }
        return out;
      };

      // 3. Plan windows (pure) with the single documented quote fallback.
      const windows = await planEpisodeWindowsWithFallback({
        recalledFacts: facts,
        maxEpisodes,
        maxTurnsPerEpisode: maxTurns,
        locateQuote: async (quote, sessionKey) => {
          for (const sessionId of candidateSessionIds(sessionKey)) {
            try {
              const hits = await engine.searchContextFull(quote, 1, sessionId);
              if (hits.length > 0) return hits[0]!.turn_index;
            } catch (err) {
              // One failing session read must not sink the fallback; try the
              // next candidate (fail-open per candidate).
              log.debug(
                `episodic-context: quote search failed for session ${sessionId}`,
                err,
              );
            }
          }
          return null;
        },
      });
      if (windows.length === 0) return null;

      // 4. Fetch + clean raw turns. `getMessages` bounds are inclusive, so
      // the exclusive `toTurn` passes as `toTurn - 1`.
      const episodes: Array<{
        sessionKey: string;
        fromTurn: number;
        toTurn: number;
        memoryIds: readonly string[];
        turns: ReadonlyArray<{ role: string; content: string }>;
      }> = [];
      for (const window of windows) {
        if (signal.aborted) break;
        let rows: LcmMessage[] = [];
        for (const sessionId of candidateSessionIds(window.sessionKey)) {
          try {
            const fetched = await engine.getTurnRange(
              sessionId,
              window.fromTurn,
              window.toTurn - 1,
            );
            if (fetched.length > 0) {
              rows = fetched;
              break;
            }
          } catch (err) {
            // A failing session read skips that candidate only; the window
            // is dropped when every candidate fails (fail-open).
            log.debug(
              `episodic-context: turn-range read failed for session ${sessionId}`,
              err,
            );
          }
        }
        if (rows.length === 0) continue;
        const turns = rows
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role,
            content:
              m.role === "user"
                ? cleanArchivedUserMessage(m.content)
                : m.content,
          }))
          .map((turn) => ({
            ...turn,
            content:
              turn.content.length > EPISODIC_TURN_CHAR_LIMIT
                ? `${turn.content.slice(0, EPISODIC_TURN_CHAR_LIMIT)}…`
                : turn.content,
          }));
        if (turns.length === 0) continue;
        episodes.push({
          sessionKey: window.sessionKey,
          fromTurn: window.fromTurn,
          toTurn: window.toTurn,
          memoryIds: window.memoryIds,
          turns,
        });
      }
      return episodes.length > 0
        ? deps.recallResultFormatter.formatEpisodicContext(episodes)
        : null;
    },
  });

  options.recordMetric({
    section: "episodicContext",
    priority: "enrichment",
    durationMs: outcome.durationMs,
    deadlineMs,
    source: outcome.timedOut ? "timeout" : "fresh",
    success: true,
    ...(outcome.timedOut
      ? { timing: `timeout(${Math.max(0, Math.round(outcome.durationMs))}ms)` }
      : {}),
  });
  if (outcome.value === null) return;
  const maxChars = deps.getRecallSectionMaxChars("episodic-context");
  const body =
    typeof maxChars === "number"
      ? deps.truncateRecallSectionToBudget(outcome.value, maxChars)
      : outcome.value;
  deps.appendRecallSection(options.sectionBuckets, "episodic-context", body);
}
