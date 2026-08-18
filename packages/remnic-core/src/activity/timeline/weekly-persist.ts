/**
 * Versioned weekly time/activity snapshot store (issue #2052).
 *
 * Files live at `<memoryDir>/activity/weekly/<ns>/<week>--<identity>.json`,
 * outside recall fallback dirs. Same inputs skip rewrite by content hash.
 * A new sourceRevision or configHash is a new file.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { namespaceIdentityToken } from "../../namespaces/identity.js";
import { hashActivityBody, isValidActivityDate } from "../digest.js";
import type { WeeklyActivitySummary } from "./weekly.js";

export const WEEKLY_SNAPSHOT_FORMAT_VERSION = 1;
export const WEEKLY_SNAPSHOT_DIR = path.join("activity", "weekly");

export interface PersistWeeklySnapshotInput {
  memoryDir: string;
  namespace: string;
  summary: WeeklyActivitySummary;
  sourceRevision: string;
  configHash: string;
}

export interface PersistWeeklySnapshotResult {
  path: string;
  written: boolean;
}

function requireToken(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function weeklySnapshotPath(input: PersistWeeklySnapshotInput): string {
  const memoryDir = requireToken(input.memoryDir, "memoryDir");
  const namespace = requireToken(input.namespace, "namespace");
  const sourceRevision = requireToken(input.sourceRevision, "sourceRevision");
  const configHash = requireToken(input.configHash, "configHash");
  const weekStartUtc = input.summary?.weekStartUtc;
  if (typeof weekStartUtc !== "string") {
    throw new TypeError("summary.weekStartUtc must be an ISO timestamp");
  }
  const weekDate = weekStartUtc.slice(0, 10);
  if (!isValidActivityDate(weekDate)) {
    throw new RangeError("summary.weekStartUtc must be an ISO timestamp");
  }
  const identity = hashActivityBody(
    `${input.summary.weekStartUtc}\0${input.summary.weekEndUtc}\0${sourceRevision}\0${configHash}`,
  );
  return path.join(
    path.resolve(memoryDir),
    WEEKLY_SNAPSHOT_DIR,
    namespaceIdentityToken(namespace),
    `${weekDate}--${identity}.json`,
  );
}

/** Persist one weekly snapshot. Same bytes are a no-op. */
export function persistWeeklySnapshot(input: PersistWeeklySnapshotInput): PersistWeeklySnapshotResult {
  const namespace = requireToken(input.namespace, "namespace");
  const sourceRevision = requireToken(input.sourceRevision, "sourceRevision");
  const configHash = requireToken(input.configHash, "configHash");
  const filePath = weeklySnapshotPath(input);
  const payload = {
    formatVersion: WEEKLY_SNAPSHOT_FORMAT_VERSION,
    namespace,
    sourceRevision,
    configHash,
    summary: input.summary,
  };
  const contentHash = hashActivityBody(JSON.stringify(payload));
  const text = `${JSON.stringify({ ...payload, contentHash })}\n`;

  try {
    if (readFileSync(filePath, "utf8") === text) {
      return { path: filePath, written: false };
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error;
  }
  return { path: filePath, written: true };
}
