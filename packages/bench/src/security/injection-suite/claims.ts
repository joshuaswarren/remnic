/**
 * Multi-host row claims for the H5 injection suite (#1962).
 *
 * mkdir(2) lock + owner.json + heartbeat. A live foreign claim means
 * skip the row (another box is working it). An expired claim is
 * reclaimed. Pause/resume still owns the checkpoint file.
 */

import { hostname } from "node:os";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InjectionSuiteRowIdentity } from "./types.js";
import { buildInjectionSuiteRowKey } from "./store.js";

export const DEFAULT_CLAIM_LEASE_MS = 15 * 60_000;
export const DEFAULT_CLAIM_HEARTBEAT_MS = 30_000;

export interface InjectionSuiteClaim {
  rowKey: string;
  ownerToken: string;
  lockPath: string;
}

interface ClaimOwner {
  schemaVersion: 1;
  rowKey: string;
  ownerToken: string;
  host: string;
  pid: number;
  leaseMs: number;
  claimedAt: string;
}

export class InjectionSuiteClaimLock {
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly checkpointsDir: string,
    private readonly leaseMs = DEFAULT_CLAIM_LEASE_MS,
    private readonly heartbeatMs = DEFAULT_CLAIM_HEARTBEAT_MS,
  ) {}

  lockPath(rowKey: string): string {
    return path.join(this.checkpointsDir, `${rowKey}.lock`);
  }

  async tryClaim(identity: InjectionSuiteRowIdentity): Promise<InjectionSuiteClaim | "busy"> {
    const rowKey = buildInjectionSuiteRowKey(identity);
    const lockPath = this.lockPath(rowKey);
    await mkdir(this.checkpointsDir, { recursive: true });
    const ownerToken = randomUUID();
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await this.reclaimIfExpired(lockPath)) {
        return this.tryClaim(identity);
      }
      return "busy";
    }
    const owner: ClaimOwner = {
      schemaVersion: 1,
      rowKey,
      ownerToken,
      host: hostname(),
      pid: process.pid,
      leaseMs: this.leaseMs,
      claimedAt: new Date().toISOString(),
    };
    try {
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        flag: "wx",
      });
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    this.startHeartbeat(lockPath);
    return { rowKey, ownerToken, lockPath };
  }

  async release(claim: InjectionSuiteClaim): Promise<void> {
    this.stopHeartbeat(claim.lockPath);
    await rm(claim.lockPath, { recursive: true, force: true });
  }

  private startHeartbeat(lockPath: string): void {
    this.stopHeartbeat(lockPath);
    const timer = setInterval(() => {
      void utimes(path.join(lockPath, "owner.json"), new Date(), new Date()).catch(() => undefined);
    }, this.heartbeatMs);
    timer.unref?.();
    this.heartbeats.set(lockPath, timer);
  }

  private stopHeartbeat(lockPath: string): void {
    const timer = this.heartbeats.get(lockPath);
    this.heartbeats.delete(lockPath);
    clearInterval(timer);
  }

  private async reclaimIfExpired(lockPath: string): Promise<boolean> {
    try {
      const ownerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
      const owner = JSON.parse(ownerRaw) as ClaimOwner;
      const stamp = await stat(path.join(lockPath, "owner.json"));
      const ageMs = Date.now() - stamp.mtimeMs;
      const leaseMs = typeof owner.leaseMs === "number" && owner.leaseMs > 0 ? owner.leaseMs : this.leaseMs;
      if (ageMs < leaseMs) return false;
      await rm(lockPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
