import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingsNamespaceHarness } from "../testing/subjects/meetings-namespace-harness.js";

const scope = (namespace: string, principal: string) => ({ namespace, authenticatedPrincipal: principal });

test("manual wearables sync flushes the debounced meeting build (P2): the build runs before the one-shot caller returns", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-03-10";
  try {
    await h.service.wearablesSync({ date: DATE, ...scope("nsA", "pA") });

    const storageA = await h.storageForNs("nsA");
    assert.deepEqual(
      await storageA.meetingRecordStore().listMeetingDates(),
      [DATE],
      "manual sync ran the debounced meeting build (record present without an explicit build)",
    );
  } finally {
    await h.cleanup();
  }
});

test("auto-sync path keeps the meeting build debounced (P2): the shared wearables service's direct sync does NOT flush eagerly", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-03-11";
  try {
    await h.orchestrator.getWearablesService("nsA").sync({ date: DATE });

    const storageA = await h.storageForNs("nsA");
    assert.deepEqual(
      await storageA.meetingRecordStore().listMeetingDates(),
      [],
      "auto-sync path left the meeting build debounced (no eager flush)",
    );

    await (await h.orchestrator.getMeetingsService("nsA")).flushBuilds();
    assert.deepEqual(
      await storageA.meetingRecordStore().listMeetingDates(),
      [DATE],
      "the debounced build was pending, not skipped",
    );
  } finally {
    await h.cleanup();
  }
});
