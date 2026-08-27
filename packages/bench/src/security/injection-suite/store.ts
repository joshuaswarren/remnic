/**
 * Per-row checkpoint store for the H5 injection suite (#1962).
 *
 * Terminal immutability, malformed-checkpoint fail-closed, durable JSON
 * on every try. Multi-host exclusion lives in claims.ts (mkdir lease).
 */

import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  InjectionSuiteCheckpoint,
  InjectionSuiteEpisodeRow,
  InjectionSuiteRowIdentity,
  InjectionSuiteTry,
} from "./types.js";
import { INJECTION_SUITE_VERSION } from "./types.js";

export function buildInjectionSuiteRowKey(identity: InjectionSuiteRowIdentity): string {
  const payload = [
    identity.suiteVersion,
    identity.stage,
    identity.modelProfileId,
    identity.arm,
    identity.family,
    identity.variantId,
    String(identity.seed),
  ].join("\u0000");
  return `h5-row-v2-${createHash("sha256").update(payload).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = record[key];
    }
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

export class InjectionSuiteRowStore {
  readonly outputDir: string;
  readonly checkpointsDir: string;

  constructor(outputDir: string) {
    this.outputDir = path.resolve(outputDir);
    this.checkpointsDir = path.join(this.outputDir, "checkpoints");
  }

  checkpointPath(identity: InjectionSuiteRowIdentity): string {
    return path.join(this.checkpointsDir, `${buildInjectionSuiteRowKey(identity)}.json`);
  }

  async load(
    identity: InjectionSuiteRowIdentity,
  ): Promise<
    | { kind: "MISSING" }
    | { kind: "VALID"; checkpoint: InjectionSuiteCheckpoint }
    | { kind: "MALFORMED"; error: Error }
  > {
    const rowKey = buildInjectionSuiteRowKey(identity);
    let raw: string;
    try {
      raw = await readFile(this.checkpointPath(identity), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "MISSING" };
      return { kind: "MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
    try {
      const parsed = JSON.parse(raw) as InjectionSuiteCheckpoint;
      if (parsed.rowKey !== rowKey) throw new Error("checkpoint rowKey does not match identity");
      if (canonicalJson(parsed.identity) !== canonicalJson(identity)) {
        throw new Error("checkpoint identity does not exactly match requested identity");
      }
      if (!Array.isArray(parsed.tries)) throw new Error("checkpoint tries must be an array");
      if (
        parsed.inFlight !== undefined
        && (!Number.isInteger(parsed.inFlight.attempt)
          || parsed.inFlight.attempt < 1
          || typeof parsed.inFlight.startedAt !== "string")
      ) {
        throw new Error("checkpoint inFlight marker is malformed");
      }
      return { kind: "VALID", checkpoint: parsed };
    } catch (error) {
      return { kind: "MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async markInFlight(
    identity: InjectionSuiteRowIdentity,
    attempt: number,
    replaceAmbiguous = false,
  ): Promise<InjectionSuiteCheckpoint> {
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("in-flight attempt must be positive");
    const existing = await this.load(identity);
    if (existing.kind === "MALFORMED") throw existing.error;
    if (existing.kind === "VALID" && existing.checkpoint.terminal) {
      throw new Error(`Injection-suite row ${existing.checkpoint.rowKey} is terminal and immutable`);
    }
    if (existing.kind === "VALID" && existing.checkpoint.inFlight && !replaceAmbiguous) {
      throw new Error(`Injection-suite row ${existing.checkpoint.rowKey} has an ambiguous in-flight request`);
    }
    const checkpoint: InjectionSuiteCheckpoint = {
      rowKey: buildInjectionSuiteRowKey(identity),
      identity,
      tries: existing.kind === "VALID" ? existing.checkpoint.tries : [],
      inFlight: { attempt, startedAt: new Date().toISOString() },
    };
    await writeFileAtomically(
      this.checkpointPath(identity),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
    return checkpoint;
  }

  async commitTry(
    identity: InjectionSuiteRowIdentity,
    entry: InjectionSuiteTry,
    terminal?: InjectionSuiteEpisodeRow,
  ): Promise<InjectionSuiteCheckpoint> {
    const existing = await this.load(identity);
    if (existing.kind === "MALFORMED") throw existing.error;
    if (existing.kind === "VALID" && existing.checkpoint.terminal) {
      throw new Error(`Injection-suite row ${existing.checkpoint.rowKey} is terminal and immutable`);
    }
    if (
      existing.kind === "VALID"
      && existing.checkpoint.inFlight
      && existing.checkpoint.inFlight.attempt !== entry.attempt
    ) {
      throw new Error("completed attempt does not match the in-flight marker");
    }
    const tries = existing.kind === "VALID" ? [...existing.checkpoint.tries, entry] : [entry];
    const checkpoint: InjectionSuiteCheckpoint = {
      rowKey: buildInjectionSuiteRowKey(identity),
      identity,
      tries,
      ...(terminal ? { terminal } : {}),
    };
    await writeFileAtomically(
      this.checkpointPath(identity),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
    return checkpoint;
  }
}

export function defaultSuiteIdentity(
  partial: Omit<InjectionSuiteRowIdentity, "suiteVersion" | "stage"> & {
    stage?: InjectionSuiteRowIdentity["stage"];
  },
): InjectionSuiteRowIdentity {
  return { suiteVersion: INJECTION_SUITE_VERSION, ...partial, stage: partial.stage ?? "base" };
}
