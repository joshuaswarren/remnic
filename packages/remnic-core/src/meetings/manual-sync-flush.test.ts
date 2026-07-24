/**
 * Manual wearables-sync tail-step flush (P2 gap).
 *
 * The meeting tail-step (`MeetingsService.requestBuild`) arms a DEBOUNCED,
 * unref'd 5s timer. A long-lived orchestrator lets that timer fire; a
 * short-lived one-shot caller (manual `remnic wearables sync` over CLI/HTTP/MCP)
 * reaches its shutdown before the debounce fires, so the meeting build never
 * ran for a manual sync.
 *
 * `EngramAccessService.wearablesSync` — the shared manual sync path every
 * one-shot host funnels through — now drains the debounced build
 * (`flushBuilds()`) after sync completes, so the meeting build actually runs
 * before the caller exits. The long-lived auto-sync daemon calls the shared
 * wearables service's `sync` DIRECTLY (never through this method) and must keep
 * coalescing on the debounce timer instead of flushing eagerly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingsNamespaceHarness } from "../testing/subjects/meetings-namespace-harness.js";

const scope = (namespace: string, principal: string) => ({ namespace, authenticatedPrincipal: principal });

test("manual wearables sync flushes the debounced meeting build (P2): the build runs before the one-shot caller returns", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-03-10";
  try {
    // Manual one-shot path (CLI/HTTP/MCP funnel through EngramAccessService).
    await h.service.wearablesSync({ date: DATE, ...scope("nsA", "pA") });

    // No explicit meetingsBuild and no 5s wait: the meeting record can only
    // exist if the manual sync drained the debounced tail-step build. Before
    // the fix the build sat on an unfired unref'd timer and this was empty.
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
    // Daemon-style path: startWearablesAutoSync's adapter calls the shared
    // wearables service's `sync` directly, bypassing EngramAccessService. It
    // must arm the debounce, not flush it.
    await h.orchestrator.getWearablesService("nsA").sync({ date: DATE });

    const storageA = await h.storageForNs("nsA");
    assert.deepEqual(
      await storageA.meetingRecordStore().listMeetingDates(),
      [],
      "auto-sync path left the meeting build debounced (no eager flush)",
    );

    // The pending build is real, not impossible: draining it now produces the
    // record — proving the auto-sync path merely deferred it on the timer.
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
