/**
 * Session-experience mining helpers (issue #2979 layer 3).
 *
 * Promoted experience memories are `category: procedure` with
 * `experience_*` attributes. When `sessionExperience.enabled` is true they
 * join the procedure-miner record set as pre-structured trajectories.
 * Call `collectProcedureMiningRecords` with `experienceEnabled: false` for
 * the gate-off path — that branch must not read storage and must return
 * the trajectory lookback set unchanged.
 */
import {
  filterTrajectoriesByLookbackDays,
  type CausalTrajectoryRecord,
} from "../causal-trajectory.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import type { ObjectiveStateOutcome } from "../objective-state.js";
import type { MemoryFile } from "../types.js";
import { isSessionExperienceMemory } from "./session-experience-recall.js";

export interface ExperienceMiningStorage {
  readAllMemories(): Promise<MemoryFile[]>;
}

export interface CollectProcedureMiningRecordsOptions {
  trajectories: CausalTrajectoryRecord[];
  lookbackDays: number;
  storage: ExperienceMiningStorage;
  experienceEnabled: boolean;
  nowMs?: number;
}

function mapExperienceOutcome(raw: string | undefined): ObjectiveStateOutcome {
  if (raw === "success" || raw === "failure" || raw === "partial") return raw;
  return "unknown";
}

/** Convert one promoted episode into a mining record, or `null`. */
export function experienceMemoryToMiningRecord(memory: MemoryFile): CausalTrajectoryRecord | null {
  if (!isSessionExperienceMemory(memory)) return null;
  if (!isActiveMemoryStatus(memory.frontmatter.status)) return null;
  const attrs = memory.frontmatter.structuredAttributes ?? {};
  const situation = (attrs.experience_situation ?? "").trim();
  const hash = attrs.experience_session_hash;
  if (situation.length === 0 || typeof hash !== "string" || hash.length === 0) return null;
  const recordedAt = memory.frontmatter.created;
  if (!recordedAt || !Number.isFinite(Date.parse(recordedAt))) return null;
  const approach = (attrs.experience_approach ?? "").trim();
  const reflection = (attrs.experience_reflection ?? "").trim();
  const record: CausalTrajectoryRecord = {
    schemaVersion: 1,
    trajectoryId: `experience:${hash}`,
    recordedAt,
    sessionKey: hash,
    goal: situation,
    actionSummary: approach,
    observationSummary: reflection,
    outcomeKind: mapExperienceOutcome(attrs.experience_outcome),
    outcomeSummary: reflection,
  };
  if (typeof memory.frontmatter.entityRef === "string" && memory.frontmatter.entityRef.trim().length > 0) {
    record.entityRefs = [memory.frontmatter.entityRef.trim()];
  }
  return record;
}

export async function collectExperienceMiningRecords(
  storage: ExperienceMiningStorage,
): Promise<CausalTrajectoryRecord[]> {
  const memories = await storage.readAllMemories();
  const out: CausalTrajectoryRecord[] = [];
  for (const memory of memories) {
    const record = experienceMemoryToMiningRecord(memory);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Records the miner will cluster. Gate off returns the lookback-filtered
 * trajectories only and does not call storage.
 */
export async function collectProcedureMiningRecords(
  options: CollectProcedureMiningRecordsOptions,
): Promise<CausalTrajectoryRecord[]> {
  const source =
    options.experienceEnabled === true
      ? options.trajectories.concat(await collectExperienceMiningRecords(options.storage))
      : options.trajectories;
  return filterTrajectoriesByLookbackDays(source, options.lookbackDays, options.nowMs);
}
