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
    if (row.dimensions.restart) {
      await state.harness.reopen();
    }
  },

  async invariants(state): Promise<void> {
    assert.equal(
      await meetingCountFor(state.harness, CALLER, state.date),
      1,
      "caller namespace reads its own meeting record",
    );
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
