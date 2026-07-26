/**
 * Profile-header write-boundary subject for the lifecycle scenario matrix.
 * Profile content is not session state, so only the session-end mutation row
 * applies; the remaining canonical rows are explicit skips rather than false
 * extraction-lifecycle coverage.
 */

import assert from "node:assert/strict";

import { StorageManager } from "../../storage.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface ProfileHeaderState {
  dir: string;
  storage: StorageManager;
  writeStartedAt?: number;
}

const STALE_PROFILE = [
  "# Behavioral Profile",
  "",
  "*Last updated: 2024-01-02T03:04:05.000Z*",
  "",
  "- Profile content survives the write boundary.",
  "",
].join("\n");

const subject: LifecycleSubject<ProfileHeaderState> = {
  appliesTo(row: MatrixRow): boolean | string {
    return row.id === "session-end"
      ? true
      : "profile writes have no provider, restart, or replay variants; direct profile tests cover those boundaries";
  },

  async setup(row: MatrixRow): Promise<ProfileHeaderState> {
    const dir = await mkTempMemoryDir(`profile-header-${row.id}`);
    try {
      return { dir, storage: new StorageManager(dir) };
    } catch (error) {
      await cleanupDir(dir);
      throw error;
    }
  },

  async exercise(state: ProfileHeaderState): Promise<void> {
    state.writeStartedAt = Date.now();
    await state.storage.writeProfile(STALE_PROFILE);
  },

  async invariants(state: ProfileHeaderState): Promise<void> {
    const profile = await state.storage.readProfile();
    const headers = profile.match(/^\*Last updated: .*\*$/gm) ?? [];
    assert.equal(headers.length, 1, "profile writes leave one canonical Last updated header");
    assert.notEqual(headers[0], "*Last updated: 2024-01-02T03:04:05.000Z*");
    assert.match(profile, /^# Behavioral Profile$/m);

    const timestamp = headers[0]?.match(/^\*Last updated: ([^*]+)\*$/)?.[1];
    assert.ok(timestamp, "the canonical header contains an ISO timestamp");
    const updatedAt = Date.parse(timestamp);
    assert.ok(Number.isFinite(updatedAt), "the profile header timestamp is parseable");
    assert.ok(updatedAt >= (state.writeStartedAt ?? 0), "the header advances at the write boundary");
    assert.ok(updatedAt <= Date.now(), "the header is not in the future");
  },

  async teardown(state: ProfileHeaderState): Promise<void> {
    await cleanupDir(state.dir);
  },
};

runLifecycleMatrix("profile-header-write", subject);
