/**
 * Caller-derived namespace-symmetry isolation tests (issue #2123).
 *
 * Two principals on distinct NON-default namespaces exercise the full
 * wearablesSync -> meetingsBuild path against a real Orchestrator +
 * EngramAccessService. Asserts (mirroring the extraction-run namespace-isolation
 * pattern, keyed on storageForNs(ns).dir):
 *   1. principal A's wearable source transcript, meeting record, and episode
 *      memory physically land under A's namespace root;
 *   2. principal B (a different non-default namespace) sees NONE of A's data;
 *   3. a non-default caller receives NEITHER default-ns wearable days NOR the
 *      machine-global activity store — a day with only default wearables + global
 *      activity yields zero meetings for a non-default caller, while the
 *      DEFAULT/machine-owner caller DOES consume both.
 *
 * These fail before the caller-derived namespace fix: with a single
 * machine-default-pinned service, A's writes would land in the default root (not
 * A's), B would observe them, and a non-default caller would fuse default
 * wearables + global activity.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MEETING_SOURCE_PREFIX } from "./memory-gen.js";
import {
  FAKE_WEARABLE_SOURCE,
  buildMeetingsNamespaceHarness,
} from "../testing/subjects/meetings-namespace-harness.js";

const scope = (namespace: string, principal: string) => ({
  namespace,
  authenticatedPrincipal: principal,
});

function meetingMemoryCount(memories: ReadonlyArray<{ frontmatter: { tags?: readonly string[] } }>): number {
  return memories.filter((m) => (m.frontmatter.tags ?? []).includes(MEETING_SOURCE_PREFIX)).length;
}

test("namespace isolation: principal A's wearable source, meeting record, and episode memory land under A's namespace root", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-03-10";
  try {
    const sync = await h.service.wearablesSync({ date: DATE, ...scope("nsA", "pA") });
    assert.equal(sync[0]?.transcriptsWritten.includes(DATE), true, "sync wrote a transcript for the day");

    // The manual sync already flushed the debounced tail-step build (P2 fix;
    // see manual-sync-flush.test.ts), so this explicit build is an idempotent
    // rebuild: detection is stable (the audio meeting re-detects) and the
    // unchanged record regenerates no duplicate episode. The record + episode
    // that physically landed under nsA are asserted on storage below.
    const build = await h.service.meetingsBuild(DATE, scope("nsA", "pA"));
    assert.equal(build.enabled, true);
    assert.equal(build.meetings.length, 1, "one audio-only meeting detected from A's wearables");
    assert.equal(build.meetings[0]?.detectionSource, "audio");

    const storageA = await h.storageForNs("nsA");
    assert.notEqual(
      await storageA.readWearableDayTranscript(FAKE_WEARABLE_SOURCE, DATE),
      null,
      "wearable source transcript physically under nsA root",
    );
    assert.deepEqual(
      await storageA.meetingRecordStore().listMeetingDates(),
      [DATE],
      "meeting record physically under nsA root",
    );
    assert.equal(meetingMemoryCount(await storageA.readAllMemories()), 1, "episode memory under nsA root");
  } finally {
    await h.cleanup();
  }
});

test("namespace isolation: principal B (a different non-default namespace) sees NONE of A's data", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-03-10";
  try {
    await h.service.wearablesSync({ date: DATE, ...scope("nsA", "pA") });
    await h.service.meetingsBuild(DATE, scope("nsA", "pA"));

    const buildB = await h.service.meetingsBuild(DATE, scope("nsB", "pB"));
    assert.equal(buildB.meetings.length, 0, "B builds zero meetings — A's wearables are not visible");

    const storageB = await h.storageForNs("nsB");
    assert.equal(
      await storageB.readWearableDayTranscript(FAKE_WEARABLE_SOURCE, DATE),
      null,
      "no wearable transcript under nsB root",
    );
    assert.deepEqual(await storageB.meetingRecordStore().listMeetingDates(), [], "no meeting record under nsB root");
    assert.equal(meetingMemoryCount(await storageB.readAllMemories()), 0, "no meeting memory under nsB root");
  } finally {
    await h.cleanup();
  }
});

test("namespace isolation: a non-default caller gets neither default-ns wearables nor global activity; the machine-owner does", async () => {
  const h = await buildMeetingsNamespaceHarness();
  const DATE = "2026-05-20";
  try {
    // Only DEFAULT-ns wearables + the machine-global activity store exist for the day.
    await h.service.wearablesSync({ date: DATE, ...scope("default", "op") });
    h.seedGlobalActivity(DATE);

    // Non-default caller: strict isolation — no default-ns wearable fallback,
    // no machine-global activity → zero meetings.
    const buildNonDefault = await h.service.meetingsBuild(DATE, scope("nsB", "pB"));
    assert.equal(buildNonDefault.meetings.length, 0, "non-default caller sees no default wearables and no activity");

    // Machine-owner (default) caller: consumes default wearables AND global activity.
    const buildDefault = await h.service.meetingsBuild(DATE, scope("default", "op"));
    assert.equal(buildDefault.meetings.length, 1, "default caller detects the meeting from default wearables");
    assert.ok(
      (buildDefault.meetings[0]?.snapshotCount ?? 0) > 0,
      "default caller consumed machine-global activity (screen context snapshots)",
    );
  } finally {
    await h.cleanup();
  }
});
