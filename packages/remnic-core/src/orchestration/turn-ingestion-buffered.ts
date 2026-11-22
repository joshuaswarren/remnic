/** Buffered durable replay ingest (#3368 split from turn-ingestion.ts — 1200-line ratchet). */

import { ReplayAdmissionRefusedError, StorageTargetRequiredError } from "../buffer-admission.js";
import type { BoundedAdmissionRefusal } from "../buffer-add-turns-bounded.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import type { BufferTurn, CodingContext } from "../types.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import { queueBufferedCaptureScopeGroups } from "./extraction-task-queueing.js";
import type { TurnIngestionDeps } from "./turn-ingestion.js";

export async function ingestReplayBatchBuffered(
  deps: Pick<TurnIngestionDeps, "config" | "buffer" | "lcmEngine" | "queueBufferedExtraction">,
  bySession: Map<string, BufferTurn[]>,
  options: {
    archiveLcm?: boolean;
    writeNamespaceOverride?: string;
    principalOverride?: string;
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
    codingContext?: CodingContext;
    bufferAdmissionIdempotencyKey?: string;
  },
): Promise<void> {
  const resolvedWriteTarget =
    options.writeNamespaceOverride ??
    (resolveNamespaceCapabilities(deps.config).namespaces === true
      ? options.scopeProfileWritePlan?.writeNamespace
      : deps.config.defaultNamespace);
  if (!resolvedWriteTarget) {
    throw new StorageTargetRequiredError(
      "accepted capture requires an explicit storage target (writeNamespaceOverride or scopeProfileWritePlan.writeNamespace)",
    );
  }
  const pin = (turn: BufferTurn): BufferTurn => {
    const pinned: BufferTurn = { ...turn, acceptedCapture: true, writeNamespaceOverride: resolvedWriteTarget };
    if (options.codingContext) pinned.codingContext = options.codingContext;
    if (options.principalOverride) pinned.principalOverride = options.principalOverride;
    if (options.scopeProfileWritePlan) pinned.scopeProfileWritePlan = options.scopeProfileWritePlan;
    return pinned;
  };
  const admissionKey = options.bufferAdmissionIdempotencyKey?.trim();
  const batches = [...bySession].map(([bufferKey, sessionTurns]) => ({ bufferKey, turns: sessionTurns.map(pin) }));
  let refusal: BoundedAdmissionRefusal | undefined;
  const onRefused = (reason: BoundedAdmissionRefusal): void => {
    refusal = reason;
  };
  const outcomes = admissionKey
    ? await deps.buffer.addTurnsBoundedForObserveReplay(batches, admissionKey, onRefused)
    : await deps.buffer.addTurnsBounded(batches, onRefused);
  if (outcomes === "duplicate") return;
  if (outcomes === null) throw replayRefusal(refusal, batches);

  await deps.buffer.flushPendingSave({ throwOnFailure: true });

  if (options.archiveLcm !== false && deps.lcmEngine?.enabled) {
    for (const [bufferKey, sessionTurns] of bySession) {
      await deps.lcmEngine.observeMessages(
        bufferKey,
        sessionTurns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          parts: turn.parts,
          rawContent: turn.rawContent,
          sourceFormat: turn.sourceFormat,
        })),
      );
    }
  }

  for (const { bufferKey, outcome } of outcomes) {
    if (outcome.decision !== "keep_buffering" && outcome.extractionTurns) {
      queueBufferedCaptureScopeGroups(deps.queueBufferedExtraction, outcome.extractionTurns, bufferKey, options);
    }
  }
}

function replayRefusal(
  refusal: BoundedAdmissionRefusal | undefined,
  batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[],
): ReplayAdmissionRefusedError {
  if (refusal?.reason === "session_turn_cap") {
    return new ReplayAdmissionRefusedError(
      `durable observe capture refused: session ${refusal.bufferKey} holds the per-session turn cap ` +
        `(${refusal.maxTurnsPerSession}) of unextracted turns; retry after extraction drains it`,
    );
  }
  const refusedKey = batches.find((batch) => batch.turns.length > 0)?.bufferKey ?? "unknown";
  const cap = refusal?.reason === "session_entry_cap" ? ` (${refusal.maxSessionEntries})` : "";
  return new ReplayAdmissionRefusedError(
    `durable observe capture refused: extraction buffer at entry capacity, session-entry cap${cap} ` +
      `full for batch containing ${refusedKey}`,
  );
}
