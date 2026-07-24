/**
 * Standalone `remnic wearables sync` meeting-build flush (issue #2123).
 *
 * The meeting tail-step (MeetingsService.requestBuild) arms a DEBOUNCED, unref'd
 * 5s timer. The standalone `remnic` binary's wearables path (main() -> case
 * "wearables") runs the shared sync runner then shuts its one-shot orchestrator
 * down; before the fix it exited before that timer fired, so a manual
 * `remnic wearables sync` never ran the meeting build. main() now drains the
 * pending build (flushBuilds()) after a `sync` subcommand returns 0 with
 * meetings enabled — mirroring cli.ts forwardWearables + EngramAccessService.
 *
 * The long-lived auto-sync daemon calls the shared wearables service's `sync`
 * DIRECTLY (never through the binary's one-shot path) and must keep coalescing
 * on the debounce timer instead of flushing eagerly — the second test guards
 * that this fix did not turn the auto-sync path into an eager flush.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Orchestrator,
  clearWearableConnectors,
  parseConfig,
  registerWearableConnector,
  type WearableSourceConnector,
} from "@remnic/core";

import { runCli } from "./run-cli.js";

const SOURCE = "faketest";

/** Deterministic fake connector: one 30-minute conversation with two distinct
 *  non-wearer speakers for whatever day is requested — enough to fire audio-only
 *  meeting detection so the debounced build has real work to do. */
function registerFake(): void {
  clearWearableConnectors();
  registerWearableConnector({
    id: SOURCE,
    displayName: "Fake Test Wearable",
    factory: (): WearableSourceConnector => ({
      id: SOURCE,
      displayName: "Fake Test Wearable",
      async verifyAuth() {
        return { ok: true };
      },
      async fetchConversations(opts) {
        const day = opts.date;
        return {
          conversations: [
            {
              id: `conv-${day}`,
              source: SOURCE,
              title: "Planning sync",
              startIso: `${day}T14:00:00.000Z`,
              endIso: `${day}T14:30:00.000Z`,
              segments: [
                { text: "hi team", speakerKey: "me", speakerName: "Me", isWearer: true, startIso: `${day}T14:00:00.000Z`, endIso: `${day}T14:00:30.000Z` },
                { text: "the quarterly numbers look strong", speakerKey: "alice", speakerName: "Alice", isWearer: false, startIso: `${day}T14:05:00.000Z`, endIso: `${day}T14:06:00.000Z` },
                { text: "agreed, let us ship it next week", speakerKey: "bob", speakerName: "Bob", isWearer: false, startIso: `${day}T14:20:00.000Z`, endIso: `${day}T14:21:00.000Z` },
                { text: "sounds good to me", speakerKey: "alice", speakerName: "Alice", isWearer: false, startIso: `${day}T14:29:00.000Z`, endIso: `${day}T14:29:30.000Z` },
              ],
            },
          ],
          nextCursor: null,
        };
      },
    }),
  });
}

function configRecord(memoryDir: string, meetingsEnabled = true): Record<string, unknown> {
  return {
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    namespacesEnabled: false,
    wearables: {
      enabled: true,
      autoSyncEnabled: false,
      sources: { [SOURCE]: { enabled: true, memoryMode: "off" } },
    },
    meetings: { enabled: meetingsEnabled },
  };
}

async function meetingDatesAt(memoryDir: string): Promise<string[]> {
  const verify = new Orchestrator(parseConfig(configRecord(memoryDir)));
  await verify.initialize();
  await verify.deferredReady;
  try {
    return (await verify.getStorage()).meetingRecordStore().listMeetingDates();
  } finally {
    await verify.destroy();
  }
}

test("standalone `remnic wearables sync` flushes the debounced meeting build before the one-shot process exits (#2123)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-mtg-flush-"));
  const DATE = "2026-03-10";
  registerFake();
  try {
    const configPath = path.join(memoryDir, "remnic.config.json");
    await writeFile(configPath, JSON.stringify(configRecord(memoryDir)), "utf8");

    const result = await runCli(["wearables", "sync", "--date", DATE], {
      env: {
        REMNIC_CONFIG_PATH: configPath,
        REMNIC_MEMORY_DIR: memoryDir,
        HOME: memoryDir,
        USERPROFILE: memoryDir,
      },
    });
    assert.equal(result.exitCode, 0, `sync exited non-zero: ${result.stderr}`);

    // No 5s wait and no explicit `remnic meetings build`: the meeting record can
    // only exist if main() drained the debounced tail-step build after the
    // standalone sync. Before the fix the build sat on an unfired unref'd timer.
    assert.deepEqual(
      await meetingDatesAt(memoryDir),
      [DATE],
      "standalone sync ran the debounced meeting build (record present without an explicit build)",
    );
  } finally {
    clearWearableConnectors();
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the shared wearables service's direct sync (auto-sync entrypoint) keeps the meeting build debounced — no eager flush (#2123)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-mtg-debounce-"));
  const DATE = "2026-03-11";
  registerFake();
  const orchestrator = new Orchestrator(parseConfig(configRecord(memoryDir)));
  await orchestrator.initialize();
  await orchestrator.deferredReady;
  try {
    // Daemon-style path: auto-sync calls the shared service's sync directly,
    // bypassing the binary's one-shot flush. It must arm the debounce, not flush.
    await orchestrator.getWearablesService().sync({ date: DATE });
    assert.deepEqual(
      await (await orchestrator.getStorage()).meetingRecordStore().listMeetingDates(),
      [],
      "auto-sync path left the meeting build debounced (no eager flush)",
    );

    // The pending build is real, not impossible: draining it produces the record.
    await (await orchestrator.getMeetingsService()).flushBuilds();
    assert.deepEqual(
      await (await orchestrator.getStorage()).meetingRecordStore().listMeetingDates(),
      [DATE],
      "the debounced build was pending, not skipped",
    );
  } finally {
    await orchestrator.destroy();
    clearWearableConnectors();
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
