import { createHash } from "node:crypto";

import type {
  EvidencePackSelectionReceipt,
  RecallXraySnapshot,
  TrajectoryAnalysisLineReceipt,
} from "@remnic/core";
import {
  lcmArchiveRowId,
  type LcmSummarySelectionReceipt,
} from "@remnic/core/lcm";
import type {
  BenchRecallLineageStatus,
  BenchRecallTrace,
  BenchRecallTraceCoreCapture,
  BenchRecallTraceLcmCandidate,
  BenchRecallTraceSection,
  BenchRecallTraceSelection,
} from "./types.js";

export interface BenchRecallTraceRecorder {
  appendSection(
    id: string,
    source: BenchRecallTraceSection["source"],
    renderedLength: number,
  ): void;
  recordEvidenceSelections(
    sectionId: string,
    receipts: readonly EvidencePackSelectionReceipt[],
  ): void;
  recordTrajectorySelections(
    sectionId: string,
    receipts: readonly TrajectoryAnalysisLineReceipt[],
  ): void;
  recordSummarySelections(
    sectionId: string,
    receipts: readonly LcmSummarySelectionReceipt[],
  ): void;
  recordRawRow(
    sectionId: string,
    range: { start: number; end: number },
    row: { id?: number; turn_index: number; role: string },
  ): void;
  recordLcmCandidate(candidate: BenchRecallTraceLcmCandidate): void;
  recordCoreCapture(snapshot: RecallXraySnapshot | null): void;
  finalize(returnedChars: number): BenchRecallTrace;
}

function visibleRange(start: number, end: number, returnedChars: number) {
  const visibleStart = Math.min(start, returnedChars);
  return {
    visibleStart,
    visibleEnd: Math.max(visibleStart, Math.min(end, returnedChars)),
  };
}

export function projectBenchCoreCapture(
  snapshot: RecallXraySnapshot,
): BenchRecallTraceCoreCapture {
  return {
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    ...(snapshot.traceId === undefined ? {} : { traceId: snapshot.traceId }),
    budget: { chars: snapshot.budget.chars, used: snapshot.budget.used },
    filters: snapshot.filters.map(({ name, considered, admitted }) => ({
      name,
      considered,
      admitted,
    })),
    results: snapshot.results.map((result) => {
      const scores = result.scoreDecomposition;
      return {
        memoryIdRef: {
          sha256: createHash("sha256").update(result.memoryId, "utf8").digest("hex"),
          length: Buffer.byteLength(result.memoryId, "utf8"),
        },
        servedBy: result.servedBy,
        scoreDecomposition: {
          ...(typeof scores.vector === "number" ? { vector: scores.vector } : {}),
          ...(typeof scores.bm25 === "number" ? { bm25: scores.bm25 } : {}),
          ...(typeof scores.importance === "number"
            ? { importance: scores.importance }
            : {}),
          ...(typeof scores.mmrPenalty === "number"
            ? { mmrPenalty: scores.mmrPenalty }
            : {}),
          ...(typeof scores.tierPrior === "number"
            ? { tierPrior: scores.tierPrior }
            : {}),
          ...(typeof scores.reinforcementBoost === "number"
            ? { reinforcementBoost: scores.reinforcementBoost }
            : {}),
          final: scores.final,
        },
        admittedBy: [...result.admittedBy],
        ...(result.rejectedBy === undefined ? {} : { rejectedBy: result.rejectedBy }),
        ...(result.disclosure === undefined ? {} : { disclosure: result.disclosure }),
        ...(result.estimatedTokens === undefined
          ? {}
          : { estimatedTokens: result.estimatedTokens }),
      };
    }),
  };
}

export function createBenchRecallTraceRecorder(
  requestedChars: number,
): BenchRecallTraceRecorder {
  const sections: BenchRecallTraceSection[] = [];
  const pendingSelections: Array<
    Omit<BenchRecallTraceSelection, "visibleStart" | "visibleEnd">
  > = [];
  const lcmCandidates: BenchRecallTraceLcmCandidate[] = [];
  let composedChars = 0;
  let coreCapture: BenchRecallTraceCoreCapture | undefined;

  const sectionById = (sectionId: string): BenchRecallTraceSection => {
    const section = sections.find((entry) => entry.id === sectionId);
    if (!section) throw new Error(`Unknown benchmark recall trace section: ${sectionId}`);
    return section;
  };

  const appendRelativeSelection = (
    sectionId: string,
    kind: BenchRecallTraceSelection["kind"],
    start: number,
    end: number,
    lineageStatus: BenchRecallLineageStatus,
    fields: Partial<BenchRecallTraceSelection> = {},
  ): void => {
    const section = sectionById(sectionId);
    const contentLength = section.contentEnd - section.contentStart;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > contentLength
    ) {
      throw new Error(
        `Invalid benchmark recall trace range for ${sectionId}: ${start}..${end}.`,
      );
    }
    pendingSelections.push({
      sectionId,
      kind,
      lineageStatus,
      composedStart: section.contentStart + start,
      composedEnd: section.contentStart + end,
      ...fields,
    });
  };

  return {
    appendSection(id, source, renderedLength) {
      if (!Number.isSafeInteger(renderedLength) || renderedLength < 0) {
        throw new Error("Benchmark recall trace section length must be a non-negative integer.");
      }
      if (sections.some((section) => section.id === id)) {
        throw new Error(`Duplicate benchmark recall trace section: ${id}`);
      }
      const separatorStart = composedChars;
      const contentStart = composedChars + (sections.length === 0 ? 0 : 2);
      const contentEnd = contentStart + renderedLength;
      sections.push({
        id,
        source,
        separatorStart,
        contentStart,
        contentEnd,
        composedStart: separatorStart,
        composedEnd: contentEnd,
        visibleStart: 0,
        visibleEnd: 0,
        visibleChars: 0,
      });
      composedChars = contentEnd;
    },
    recordEvidenceSelections(sectionId, receipts) {
      for (const receipt of receipts) {
        appendRelativeSelection(
          sectionId,
          "evidence-block",
          receipt.blockStart,
          receipt.blockEnd,
          receipt.item.archiveRowId === undefined ? "unavailable" : "exact",
          {
            ...(receipt.item.archiveRowId === undefined
              ? {}
              : { archiveRowIds: [receipt.item.archiveRowId] }),
            ...(receipt.item.turnIndex === undefined
              ? {}
              : { turnIndex: receipt.item.turnIndex }),
            ...(receipt.item.role === undefined ? {} : { role: receipt.item.role }),
            ...(receipt.item.score === undefined ? {} : { score: receipt.item.score }),
          },
        );
      }
    },
    recordTrajectorySelections(sectionId, receipts) {
      for (const receipt of receipts) {
        appendRelativeSelection(
          sectionId,
          "trajectory-line",
          receipt.lineStart,
          receipt.lineEnd,
          receipt.lineageStatus,
          {
            archiveRowIds: [
              ...receipt.actionArchiveRowIds,
              ...receipt.observationArchiveRowIds,
            ],
          },
        );
      }
    },
    recordSummarySelections(sectionId, receipts) {
      for (const receipt of receipts) {
        appendRelativeSelection(
          sectionId,
          "lcm-summary",
          receipt.entryStart,
          receipt.entryEnd,
          "exact",
          {
            summary: {
              id: receipt.id,
              depth: receipt.depth,
              msgStart: receipt.msgStart,
              msgEnd: receipt.msgEnd,
            },
          },
        );
      }
    },
    recordRawRow(sectionId, range, row) {
      const archiveRowId = lcmArchiveRowId(row);
      appendRelativeSelection(
        sectionId,
        "raw-row",
        range.start,
        range.end,
        archiveRowId === undefined ? "unavailable" : "exact",
        {
          ...(archiveRowId === undefined ? {} : { archiveRowIds: [archiveRowId] }),
          turnIndex: row.turn_index,
          role: row.role,
        },
      );
    },
    recordLcmCandidate(candidate) {
      lcmCandidates.push({ ...candidate });
    },
    recordCoreCapture(snapshot) {
      coreCapture = snapshot ? projectBenchCoreCapture(snapshot) : undefined;
    },
    finalize(returnedChars) {
      const normalizedReturnedChars = Math.max(0, Math.min(returnedChars, composedChars));
      return {
        schemaVersion: 1,
        sensitivity: {
          classification: "restricted",
          contentEncoding: "sha256+length",
          containsGold: false,
        },
        sections: sections.map((section) => {
          const visible = visibleRange(
            section.composedStart,
            section.composedEnd,
            normalizedReturnedChars,
          );
          return {
            ...section,
            ...visible,
            visibleChars: visible.visibleEnd - visible.visibleStart,
          };
        }),
        selections: pendingSelections.map((selection) => ({
          ...selection,
          ...visibleRange(
            selection.composedStart,
            selection.composedEnd,
            normalizedReturnedChars,
          ),
        })),
        lcmCandidates: lcmCandidates.map((candidate) => ({ ...candidate })),
        ...(coreCapture === undefined ? {} : { coreCapture }),
        budget: {
          requestedChars,
          composedChars,
          returnedChars: normalizedReturnedChars,
          truncated: normalizedReturnedChars < composedChars,
        },
      };
    },
  };
}
