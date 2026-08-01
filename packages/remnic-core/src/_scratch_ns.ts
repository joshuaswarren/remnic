import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramAccessService } from "./access-service.js";
import { clearWearableConnectors, registerWearableConnector } from "./wearables/registry.js";
import type { WearableSourceConnector } from "./wearables/types.js";

function fakeConnector(): void {
  clearWearableConnectors();
  registerWearableConnector({
    id: "faketest",
    displayName: "Fake Test",
    factory: (): WearableSourceConnector => ({
      id: "faketest",
      displayName: "Fake Test",
      async verifyAuth() {
        return { ok: true };
      },
      async fetchConversations(opts) {
        const day = opts.date;
        return {
          conversations: [
            {
              id: `conv-${day}`,
              source: "faketest",
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

async function main() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-scratch-"));
  fakeConnector();
  const config = parseConfig({
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
    ],
    wearables: {
      enabled: true,
      autoSyncEnabled: false,
      sources: { faketest: { enabled: true, memoryMode: "off" } },
    },
    meetings: { enabled: true },
  });
  const orchestrator = new Orchestrator(config) as any;
  const service = new EngramAccessService(orchestrator);
  const DATE = "2026-03-10";

  const syncA = await service.wearablesSync({ date: DATE, namespace: "nsA", authenticatedPrincipal: "pA" });
  console.log("syncA:", JSON.stringify(syncA, null, 2).slice(0, 800));

  const buildA = await service.meetingsBuild(DATE, { namespace: "nsA", authenticatedPrincipal: "pA" });
  console.log("buildA:", JSON.stringify(buildA, null, 2).slice(0, 1200));

  const storageA = await orchestrator.getStorage("nsA");
  const storageB = await orchestrator.getStorage("nsB");
  console.log("nsA dir:", storageA.dir);
  console.log("nsB dir:", storageB.dir);

  const listA = await service.meetingsList(DATE, { namespace: "nsA", authenticatedPrincipal: "pA" });
  console.log("listA meetings:", JSON.stringify(listA).slice(0, 600));

  const memsA = await storageA.readAllMemories();
  console.log("nsA memory count:", memsA.length, "meeting-tagged:", memsA.filter((m: any) => (m.frontmatter?.tags ?? []).includes("meeting")).length);

  // nsB build over same day — should be zero (no wearables, no activity)
  const buildB = await service.meetingsBuild(DATE, { namespace: "nsB", authenticatedPrincipal: "pB" });
  console.log("buildB meetings:", (buildB as any).meetings?.length, "enabled:", (buildB as any).enabled);
  const memsB = await storageB.readAllMemories();
  console.log("nsB memory count:", memsB.length);

  await orchestrator.dispose?.();
}
main().then(() => process.exit(0)).catch((e) => { console.error("SCRATCH ERR:", e); process.exit(1); });
