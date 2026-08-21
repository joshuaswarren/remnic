/**
 * Meetings caller-namespace subject for the scenario-matrix harness (issue
 * #2123). Exercises the caller-derived namespace meeting build/read path: a
 * principal on a NON-default namespace syncs wearables and builds meetings, and
 * the record must be readable in that caller namespace while a different
 * namespace stays empty.
 *
 * Most canonical rows probe session/provider-identity/compaction/dedupe
 * dimensions the meetings-namespace path has no honest analogue for — those are
 * skipped via `appliesTo` (never faked). The two realized rows map cleanly:
 *   - explicit-provider-identity → a straight caller-namespace build;
 *   - restart-reload-recovery    → reopen a fresh service over the same on-disk
 *     memoryDir and re-read the persisted caller-namespace record.
 */
import assert from "node:assert/strict";

import {
  buildMeetingsNamespaceHarness,
  type MeetingsNamespaceHarness,
} from "./meetings-namespace-harness.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface MeetingsNamespaceState {
  harness: MeetingsNamespaceHarness;
  date: string;
}

const CALLER = { namespace: "nsA", authenticatedPrincipal: "pA" } as const;
const OTHER = { namespace: "nsB", authenticatedPrincipal: "pB" } as const;

async function meetingCountFor(
  harness: MeetingsNamespaceHarness,
  scope: { namespace: string; authenticatedPrincipal: string },
  date: string,
): Promise<number> {
  const list = await harness.service.meetingsList(date, scope);
  return list.days[0]?.meetings.length ?? 0;
}

const subject: LifecycleSubject<MeetingsNamespaceState> = {
  appliesTo(row: MatrixRow): boolean | string {
    if (row.id === "explicit-provider-identity" || row.id === "restart-reload-recovery") {
      return true;
    }
    return `meetings caller-namespace build has no ${row.id} semantics to realize`;
  },

  async setup(): Promise<MeetingsNamespaceState> {
    const harness = await buildMeetingsNamespaceHarness();
    return { harness, date: "2026-06-09" };
  },

  async exercise(state, row): Promise<void> {
    await state.harness.service.wearablesSync({ date: state.date, ...CALLER });
    const build = await state.harness.service.meetingsBuild(state.date, CALLER);
    assert.equal(build.meetings.length, 1, "caller namespace detects one audio meeting");
    // restart/reload row: reopen a fresh service over the same on-disk state.
    if (row.dimensions.restart) {
      await state.harness.reopen();
    }
  },

  async invariants(state): Promise<void> {
    // Caller namespace still reads its record (survives a restart when reopened).
    assert.equal(
      await meetingCountFor(state.harness, CALLER, state.date),
      1,
      "caller namespace reads its own meeting record",
    );
    // A different namespace never observes the caller's meeting.
    assert.equal(
      await meetingCountFor(state.harness, OTHER, state.date),
      0,
      "a different namespace stays isolated from the caller's meeting",
    );
    const storageOther = await state.harness.storageForNs("nsB");
    assert.deepEqual(
      await storageOther.meetingRecordStore().listMeetingDates(),
      [],
      "no meeting record physically under the other namespace root",
    );
  },

  async teardown(state): Promise<void> {
    await state.harness.cleanup();
  },
};

runLifecycleMatrix("meetings-namespace", subject);
