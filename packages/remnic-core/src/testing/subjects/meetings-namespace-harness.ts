/**
 * Shared harness for the caller-derived namespace-symmetry surface tests
 * (issue #2123). Builds a real Orchestrator + EngramAccessService with
 * namespaces enabled and a fake wearable connector, so wearablesSync +
 * meetingsBuild exercise the full source-transcript -> detect -> record ->
 * episode-memory path against per-namespace storage roots.
 *
 * Test-only: lives under testing/ so tsup (which entry-points only top-level
 * src/*.ts) never bundles it. Imported by the two-principal isolation test and
 * the meetings-namespace lifecycle-matrix subject.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../../config.js";
import { Orchestrator } from "../../orchestrator.js";
import { EngramAccessService } from "../../access-service.js";
import { ActivityStore } from "../../activity/store.js";
import {
  clearWearableConnectors,
  registerWearableConnector,
} from "../../wearables/registry.js";
import type { WearableSourceConnector } from "../../wearables/types.js";

/** Connector id every harness meeting is sourced from. */
export const FAKE_WEARABLE_SOURCE = "faketest";

/**
 * Register a deterministic fake wearable connector that returns one 30-minute
 * conversation with two distinct non-wearer speakers for whatever day is
 * requested — enough to fire audio-only meeting detection
 * (>= audioOnlyMinMinutes, >= 2 distinct non-wearer speakers). Clears the
 * registry first so repeated harness builds in one test process never collide.
 */
export function registerFakeWearableConnector(): void {
  clearWearableConnectors();
  registerWearableConnector({
    id: FAKE_WEARABLE_SOURCE,
    displayName: "Fake Test Wearable",
    factory: (): WearableSourceConnector => ({
      id: FAKE_WEARABLE_SOURCE,
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
              source: FAKE_WEARABLE_SOURCE,
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

/** Namespaces enabled; `pA` owns `nsA`, `pB` owns `nsB` (both NON-default) with
 *  full read+write; `pWO` can WRITE `nsWO` but is omitted from its readPrincipals
 *  (write-only, for the meetingsBuild read-authorization regression, #2123); the
 *  default namespace is writable/readable by any authenticated principal, so
 *  `op` acts as the machine owner. */
function makeConfig(memoryDir: string): ReturnType<typeof parseConfig> {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    namespacesEnabled: true,
    defaultNamespace: "default",
    namespacePolicies: [
      { name: "nsA", readPrincipals: ["pA"], writePrincipals: ["pA"] },
      { name: "nsB", readPrincipals: ["pB"], writePrincipals: ["pB"] },
      { name: "nsWO", readPrincipals: [], writePrincipals: ["pWO"] },
    ],
    wearables: {
      enabled: true,
      autoSyncEnabled: false,
      sources: { [FAKE_WEARABLE_SOURCE]: { enabled: true, memoryMode: "off" } },
    },
    meetings: { enabled: true },
  });
}

export interface MeetingsNamespaceHarness {
  readonly orchestrator: Orchestrator;
  readonly service: EngramAccessService;
  readonly memoryDir: string;
  /** Namespace-root storage (records/memories/transcripts live under `.dir`).
   *  Typed via ReturnType to avoid a direct storage.ts import (ratchet #1533). */
  storageForNs(namespace: string): ReturnType<Orchestrator["getStorage"]>;
  /** Seed the machine-global activity store (<memoryDir>/state/activity.sqlite). */
  seedGlobalActivity(day: string): void;
  /**
   * Simulate a restart: tear down the live orchestrator and open a FRESH
   * Orchestrator + EngramAccessService over the same on-disk memoryDir. Returns
   * the new service; subsequent `storageForNs`/`cleanup` target the reopened
   * instance.
   */
  reopen(): Promise<EngramAccessService>;
  cleanup(): Promise<void>;
}

export async function buildMeetingsNamespaceHarness(): Promise<MeetingsNamespaceHarness> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mtg-ns-"));
  registerFakeWearableConnector();
  let orchestrator = new Orchestrator(makeConfig(memoryDir));
  let service = new EngramAccessService(orchestrator);
  const harness: MeetingsNamespaceHarness = {
    get orchestrator() {
      return orchestrator;
    },
    get service() {
      return service;
    },
    memoryDir,
    storageForNs: (namespace) => orchestrator.getStorage(namespace),
    seedGlobalActivity(day: string): void {
      const store = ActivityStore.open(memoryDir);
      try {
        store.insertSnapshot({ machine: "m1", capturedAtUtc: `${day}T14:10:00.000Z`, app: "zoom.us", windowTitle: "Planning", text: "roadmap review", textSource: "ax", contentHash: `h-${day}-1` });
        store.insertSnapshot({ machine: "m1", capturedAtUtc: `${day}T14:20:00.000Z`, app: "zoom.us", windowTitle: "Planning", text: "roadmap review 2", textSource: "ax", contentHash: `h-${day}-2` });
      } finally {
        store.close();
      }
    },
    async reopen(): Promise<EngramAccessService> {
      await orchestrator.destroy();
      registerFakeWearableConnector();
      orchestrator = new Orchestrator(makeConfig(memoryDir));
      service = new EngramAccessService(orchestrator);
      return service;
    },
    async cleanup(): Promise<void> {
      await orchestrator.destroy();
      clearWearableConnectors();
      // maxRetries absorbs a rare ENOTEMPTY when a background flush writes a
      // state file as the recursive walk removes the tree (issue #2123 test).
      await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return harness;
}
