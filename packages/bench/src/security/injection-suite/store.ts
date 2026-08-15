/**
 * Per-row checkpoint store for the H5 injection suite (#1962).
 *
 * Terminal immutability, malformed-checkpoint fail-closed, durable JSON
 * on every try. Multi-host exclusion lives in claims.ts (mkdir lease).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    identity.modelProfileId,
    identity.arm,
    identity.family,
    identity.variantId,
    String(identity.seed),
  ].join("\u0000");
  return `h5-row-v1-${createHash("sha256").update(payload).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
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
      return { kind: "VALID", checkpoint: parsed };
    } catch (error) {
      return { kind: "MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
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
    const tries = existing.kind === "VALID" ? [...existing.checkpoint.tries, entry] : [entry];
    const checkpoint: InjectionSuiteCheckpoint = {
      rowKey: buildInjectionSuiteRowKey(identity),
      identity,
      tries,
      ...(terminal ? { terminal } : {}),
    };
    await mkdir(this.checkpointsDir, { recursive: true });
    await writeFile(this.checkpointPath(identity), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    return checkpoint;
  }
}

export function defaultSuiteIdentity(
  partial: Omit<InjectionSuiteRowIdentity, "suiteVersion">,
): InjectionSuiteRowIdentity {
  return { suiteVersion: INJECTION_SUITE_VERSION, ...partial };
}
