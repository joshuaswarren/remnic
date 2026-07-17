import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELAY_DEMO_MISSION_ID,
  RELAY_DEMO_NAMESPACE,
  RelayMissionEventSchema,
  createRelayMissionFixture,
  reduceRelayMission,
} from "@remnic/core";

const FRAME_DEFINITIONS = [
  { id: "mission", label: "Mission opened", eventCount: 1, paceMs: 900 },
  { id: "agents", label: "Agents dispatched", eventCount: 3, paceMs: 900 },
  { id: "beliefs", label: "Beliefs diverge", eventCount: 7, paceMs: 1_250 },
  { id: "conflict", label: "Conflict detected", eventCount: 8, paceMs: 1_700 },
  { id: "failure", label: "Contract fails", eventCount: 9, paceMs: 1_450 },
  { id: "proposal", label: "Correction proposed", eventCount: 10, paceMs: 1_350 },
  { id: "approval", label: "Human approval", eventCount: 11, paceMs: 1_600 },
  { id: "superseded", label: "Stale belief retired", eventCount: 12, paceMs: 1_350 },
  { id: "cold-recall", label: "Cold agent recalls", eventCount: 13, paceMs: 1_500 },
  { id: "propagated", label: "Propagation verified", eventCount: 14, paceMs: 1_350 },
  { id: "passing", label: "Contract passes", eventCount: 15, paceMs: 1_500 },
  { id: "receipt", label: "Receipt sealed", eventCount: 16, paceMs: 2_000 },
] as const;

export function createRelayUiReplay() {
  const events = createRelayMissionFixture().map((input, index) =>
    RelayMissionEventSchema.parse({
      schemaVersion: "1",
      eventId: `fixture-event-${String(index + 1).padStart(3, "0")}`,
      missionId: RELAY_DEMO_MISSION_ID,
      namespace: RELAY_DEMO_NAMESPACE,
      recordedAt: input.occurredAt,
      occurredAt: input.occurredAt,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: input.payload,
    })
  );

  return {
    schemaVersion: "1",
    source: "@remnic/core createRelayMissionFixture + reduceRelayMission",
    generatedAt: "2026-07-17T18:01:00.000Z",
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    initialFrameId: "conflict",
    frames: FRAME_DEFINITIONS.map((frame) => ({
      id: frame.id,
      label: frame.label,
      paceMs: frame.paceMs,
      snapshot: reduceRelayMission({
        missionId: RELAY_DEMO_MISSION_ID,
        namespace: RELAY_DEMO_NAMESPACE,
        events: events.slice(0, frame.eventCount),
        fileExists: true,
      }),
    })),
  };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = path.join(repoRoot, "admin-console", "public", "relay", "replay.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(createRelayUiReplay(), null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
