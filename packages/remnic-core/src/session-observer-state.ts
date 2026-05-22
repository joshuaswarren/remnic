import path from "node:path";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { SessionObserverBandConfig } from "./types.js";
import { cloneDefaultSessionObserverBands } from "./session-observer-bands.js";

interface SessionObserverCursor {
  sessionKey: string;
  cursorBytes: number;
  cursorTokens: number;
  lastObservedAt: string;
  lastTriggeredAt?: string;
  lastResetAt?: string;
}

interface SessionObserverPersistedState {
  version: 1;
  sessions: Record<string, SessionObserverCursor>;
}

export interface SessionObservationInput {
  sessionKey: string;
  totalBytes: number;
  totalTokens: number;
  observedAt?: string;
}

export interface SessionObservationDecision {
  triggered: boolean;
  deltaBytes: number;
  deltaTokens: number;
  band: SessionObserverBandConfig;
  reason?: "threshold" | "debounced" | "baseline";
}

function sanitizeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function parseIsoMs(value?: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function mergeSessionCursor(
  existing: SessionObserverCursor,
  incoming: SessionObserverCursor,
): SessionObserverCursor {
  const existingObservedMs = parseIsoMs(existing.lastObservedAt);
  const incomingObservedMs = parseIsoMs(incoming.lastObservedAt);
  const existingTriggeredMs = parseIsoMs(existing.lastTriggeredAt);
  const incomingTriggeredMs = parseIsoMs(incoming.lastTriggeredAt);
  const existingResetMs = parseIsoMs(existing.lastResetAt);
  const incomingResetMs = parseIsoMs(incoming.lastResetAt);

  const observedAt =
    incomingObservedMs >= existingObservedMs ? incoming.lastObservedAt : existing.lastObservedAt;
  const triggeredAt =
    incomingTriggeredMs >= existingTriggeredMs ? incoming.lastTriggeredAt : existing.lastTriggeredAt;

  // Preserve monotonic cursor progression except for explicit reset observations.
  const incomingIsNewer = incomingObservedMs >= existingObservedMs;
  const incomingHasNewerReset = incomingResetMs > existingResetMs;
  const allowIncomingReset = incomingIsNewer && incomingHasNewerReset;
  const keepExistingReset =
    existingResetMs > incomingResetMs && existingObservedMs >= incomingObservedMs;

  let cursorBytes = Math.max(
    sanitizeNonNegativeInt(existing.cursorBytes),
    sanitizeNonNegativeInt(incoming.cursorBytes),
  );
  let cursorTokens = Math.max(
    sanitizeNonNegativeInt(existing.cursorTokens),
    sanitizeNonNegativeInt(incoming.cursorTokens),
  );
  if (keepExistingReset) {
    cursorBytes = sanitizeNonNegativeInt(existing.cursorBytes);
    cursorTokens = sanitizeNonNegativeInt(existing.cursorTokens);
  } else if (allowIncomingReset) {
    cursorBytes = sanitizeNonNegativeInt(incoming.cursorBytes);
    cursorTokens = sanitizeNonNegativeInt(incoming.cursorTokens);
  }

  return {
    sessionKey: existing.sessionKey,
    cursorBytes,
    cursorTokens,
    lastObservedAt: observedAt,
    lastTriggeredAt: triggeredAt,
    lastResetAt:
      incomingResetMs >= existingResetMs ? incoming.lastResetAt : existing.lastResetAt,
  };
}

export function normalizeObserverBands(
  bands: SessionObserverBandConfig[],
): SessionObserverBandConfig[] {
  const normalized = bands
    .map((band) => ({
      maxBytes: sanitizeNonNegativeInt(band.maxBytes),
      triggerDeltaBytes: sanitizeNonNegativeInt(band.triggerDeltaBytes),
      triggerDeltaTokens: sanitizeNonNegativeInt(band.triggerDeltaTokens),
    }))
    .filter((band) => band.maxBytes > 0)
    .sort((a, b) => a.maxBytes - b.maxBytes);

  if (normalized.length === 0) {
    return cloneDefaultSessionObserverBands();
  }

  const last = normalized[normalized.length - 1];
  if (last && last.maxBytes < 1_000_000_000) {
    normalized.push({
      maxBytes: 1_000_000_000,
      triggerDeltaBytes: last.triggerDeltaBytes,
      triggerDeltaTokens: last.triggerDeltaTokens,
    });
  }
  return normalized;
}

export class SessionObserverState {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockStaleMs = 120_000;
  private readonly debounceMs: number;
  private readonly bands: SessionObserverBandConfig[];
  private sessions = new Map<string, SessionObserverCursor>();
  private saveQueue: Promise<void> = Promise.resolve();

  private async readPersistedState(): Promise<SessionObserverPersistedState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as SessionObserverPersistedState;
      if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private normalizePersistedSessions(
    sessions: Record<string, SessionObserverCursor>,
  ): Map<string, SessionObserverCursor> {
    const next = new Map<string, SessionObserverCursor>();
    for (const [sessionKey, value] of Object.entries(sessions)) {
      if (!value || typeof value !== "object") continue;
      next.set(sessionKey, {
        sessionKey,
        cursorBytes: sanitizeNonNegativeInt(value.cursorBytes),
        cursorTokens: sanitizeNonNegativeInt(value.cursorTokens),
        lastObservedAt:
          typeof value.lastObservedAt === "string" ? value.lastObservedAt : new Date(0).toISOString(),
        lastTriggeredAt: typeof value.lastTriggeredAt === "string" ? value.lastTriggeredAt : undefined,
        lastResetAt: typeof value.lastResetAt === "string" ? value.lastResetAt : undefined,
      });
    }
    return next;
  }

  constructor(opts: {
    memoryDir: string;
    debounceMs: number;
    bands: SessionObserverBandConfig[];
  }) {
    this.statePath = path.join(opts.memoryDir, "state", "session-observer-state.json");
    this.lockPath = path.join(opts.memoryDir, "state", "session-observer-state.lock");
    this.debounceMs = Math.max(0, Math.floor(opts.debounceMs));
    this.bands = normalizeObserverBands(opts.bands);
  }

  private async withSaveLock(fn: () => Promise<void>): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          await fn();
        } finally {
          await handle.close();
          await unlink(this.lockPath).catch(() => {});
        }
        return;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        try {
          const lockInfo = await stat(this.lockPath);
          if (Date.now() - lockInfo.mtimeMs > this.lockStaleMs) {
            await unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          // Lock might have been released between EEXIST and stat/read.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const error = new Error("session observer save lock timeout");
    log.debug(error.message);
    throw error;
  }

  async load(): Promise<void> {
    const parsed = await this.readPersistedState();
    if (!parsed) {
      this.sessions.clear();
      return;
    }
    this.sessions = this.normalizePersistedSessions(parsed.sessions);
  }

  async save(): Promise<void> {
    await this.withSaveLock(async () => {
      const merged = await this.readMergedSessions();
      this.sessions = merged;

      await this.writeSessions(merged);
    });
  }

  private async readMergedSessions(): Promise<Map<string, SessionObserverCursor>> {
    const merged = new Map<string, SessionObserverCursor>();
    const persisted = await this.readPersistedState();
    if (persisted) {
      for (const [key, value] of this.normalizePersistedSessions(persisted.sessions).entries()) {
        merged.set(key, value);
      }
    }
    for (const [key, current] of this.sessions.entries()) {
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, current);
        continue;
      }
      merged.set(key, mergeSessionCursor(existing, current));
    }
    return merged;
  }

  private async writeSessions(sessionsMap: Map<string, SessionObserverCursor>): Promise<void> {
    const sessions: Record<string, SessionObserverCursor> = {};
    for (const [key, value] of sessionsMap.entries()) {
      sessions[key] = value;
    }
    const payload: SessionObserverPersistedState = { version: 1, sessions };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private enqueueObservation(
    input: SessionObservationInput,
  ): Promise<SessionObservationDecision> {
    const operation = this.saveQueue
      .catch(() => undefined)
      .then(() => this.observeWithSaveLock(input));
    this.saveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private bandForTotalBytes(totalBytes: number): SessionObserverBandConfig {
    const bytes = sanitizeNonNegativeInt(totalBytes);
    for (const band of this.bands) {
      if (bytes <= band.maxBytes) return band;
    }
    return this.bands[this.bands.length - 1];
  }

  async observe(input: SessionObservationInput): Promise<SessionObservationDecision> {
    return this.enqueueObservation(input);
  }

  private async observeWithSaveLock(
    input: SessionObservationInput,
  ): Promise<SessionObservationDecision> {
    let decision: SessionObservationDecision | undefined;
    await this.withSaveLock(async () => {
      const localExisting = this.sessions.get(input.sessionKey);
      const sessions = await this.readMergedSessions();
      decision = await this.observeMerged(
        input,
        sessions,
        localExisting ? { ...localExisting } : undefined,
      );
    });
    if (!decision) {
      throw new Error("session observer decision was not computed");
    }
    return decision;
  }

  private async observeMerged(
    input: SessionObservationInput,
    sessions: Map<string, SessionObserverCursor>,
    localExisting?: SessionObserverCursor,
  ): Promise<SessionObservationDecision> {
    const nowIso = input.observedAt ?? new Date().toISOString();
    const totalBytes = sanitizeNonNegativeInt(input.totalBytes);
    const totalTokens = sanitizeNonNegativeInt(input.totalTokens);
    const band = this.bandForTotalBytes(totalBytes);

    const existing = sessions.get(input.sessionKey);
    if (!existing) {
      sessions.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        cursorBytes: totalBytes,
        cursorTokens: totalTokens,
        lastObservedAt: nowIso,
      });
      this.sessions = sessions;
      await this.writeSessions(sessions);
      return {
        triggered: false,
        deltaBytes: 0,
        deltaTokens: 0,
        band,
        reason: "baseline",
      };
    }

    const session = { ...existing };
    const observedMs = parseIsoMs(nowIso);
    const existingObservedMs = parseIsoMs(session.lastObservedAt);
    const existingResetMs = parseIsoMs(session.lastResetAt);
    if (existingResetMs > 0 && observedMs < existingResetMs) {
      this.sessions = sessions;
      return { triggered: false, deltaBytes: 0, deltaTokens: 0, band, reason: "baseline" };
    }

    if (totalBytes < session.cursorBytes || totalTokens < session.cursorTokens) {
      const localSawReset =
        localExisting !== undefined
        && (totalBytes < sanitizeNonNegativeInt(localExisting.cursorBytes)
          || totalTokens < sanitizeNonNegativeInt(localExisting.cursorTokens));
      const canApplyReset = localSawReset && observedMs >= existingObservedMs;

      if (canApplyReset) {
        session.cursorBytes = totalBytes;
        session.cursorTokens = totalTokens;
        session.lastObservedAt = nowIso;
        session.lastResetAt = nowIso;
      } else if (observedMs >= existingObservedMs) {
        session.lastObservedAt = nowIso;
      }
      sessions.set(input.sessionKey, session);
      this.sessions = sessions;
      await this.writeSessions(sessions);
      return { triggered: false, deltaBytes: 0, deltaTokens: 0, band, reason: "baseline" };
    }

    const deltaBytes = totalBytes - session.cursorBytes;
    const deltaTokens = totalTokens - session.cursorTokens;
    const crossedThreshold =
      (band.triggerDeltaBytes > 0 && deltaBytes >= band.triggerDeltaBytes)
      || (band.triggerDeltaTokens > 0 && deltaTokens >= band.triggerDeltaTokens);
    session.lastObservedAt = nowIso;

    if (!crossedThreshold) {
      const unchanged = deltaBytes === 0 && deltaTokens === 0;
      if (!unchanged) {
        sessions.set(input.sessionKey, session);
        this.sessions = sessions;
        await this.writeSessions(sessions);
      } else {
        this.sessions = sessions;
      }
      return {
        triggered: false,
        deltaBytes,
        deltaTokens,
        band,
      };
    }

    const nowMs = Date.parse(nowIso);
    const lastTriggeredMs = session.lastTriggeredAt ? Date.parse(session.lastTriggeredAt) : NaN;
    const withinDebounce =
      Number.isFinite(lastTriggeredMs) && nowMs - lastTriggeredMs < this.debounceMs;

    if (withinDebounce) {
      sessions.set(input.sessionKey, session);
      this.sessions = sessions;
      await this.writeSessions(sessions);
      return {
        triggered: false,
        deltaBytes,
        deltaTokens,
        band,
        reason: "debounced",
      };
    }

    session.lastTriggeredAt = nowIso;
    session.cursorBytes = totalBytes;
    session.cursorTokens = totalTokens;
    sessions.set(input.sessionKey, session);
    this.sessions = sessions;
    await this.writeSessions(sessions);
    return {
      triggered: true,
      deltaBytes,
      deltaTokens,
      band,
      reason: "threshold",
    };
  }
}
