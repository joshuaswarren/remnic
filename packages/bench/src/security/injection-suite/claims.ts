/**
 * Multi-host row claims for the H5 injection suite (#1962).
 *
 * mkdir(2) lock + owner.json + heartbeat. A live foreign claim means
 * skip the row. Expired / incomplete locks are renamed aside before
 * a new mkdir, so two reclaimers cannot both become owners.
 */

import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
    try {
      const ownerPath = path.join(claim.lockPath, "owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as ClaimOwner;
      if (owner.ownerToken !== claim.ownerToken) return;
      await rename(ownerPath, `${ownerPath}.released-${claim.ownerToken}`);
    } catch {
      return;
    }
    const released = `${claim.lockPath}.released-${claim.ownerToken}`;
    try {
      await rename(claim.lockPath, released);
    } catch {
      return;
    }
    await rm(released, { recursive: true, force: true });
  }

  async assertOwner(claim: InjectionSuiteClaim): Promise<void> {
    const owner = JSON.parse(await readFile(path.join(claim.lockPath, "owner.json"), "utf8")) as ClaimOwner;
    if (owner.ownerToken !== claim.ownerToken) {
      throw new Error(`lost injection-suite claim ${claim.rowKey}`);
    }
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
    const ownerPath = path.join(lockPath, "owner.json");
    let leaseMs = this.leaseMs;
    let stampMs: number;
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as ClaimOwner;
      if (typeof owner.leaseMs === "number" && owner.leaseMs > 0) leaseMs = owner.leaseMs;
      stampMs = (await stat(ownerPath)).mtimeMs;
    } catch {
      try {
        stampMs = (await stat(lockPath)).mtimeMs;
      } catch {
        return false;
      }
    }
    if (Date.now() - stampMs < leaseMs) return false;
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch {
      return false;
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  }
}
