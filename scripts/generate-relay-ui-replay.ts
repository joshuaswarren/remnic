import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELAY_DEMO_MISSION_ID,
  RELAY_DEMO_NAMESPACE,
  RelayMissionEventSchema,
  createRelayMissionFixture,
  reduceRelayMission,
  type RelayMissionEvent,
} from "@remnic/core";

import { verifyRelayRecording } from "./relay/recording.js";

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

function replayFromEvents(
  events: RelayMissionEvent[],
  source: string,
  generatedAt: string,
) {
  if (events.length !== 16) throw new Error("Relay Mission Control replay requires exactly 16 evidence events");
  return {
    schemaVersion: "1",
    source,
    generatedAt,
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
  return replayFromEvents(
    events,
    "@remnic/core createRelayMissionFixture + reduceRelayMission",
    "2026-07-17T18:01:00.000Z",
  );
}

export async function createRelayUiReplayFromRecording(recordingDir: string, repoRoot: string) {
  const recording = await verifyRelayRecording(recordingDir, repoRoot);
  return replayFromEvents(
    recording.events,
    `integrity-checked Remnic Relay recording sha256:${recording.rootSha256}`,
    recording.metadata.generatedAt,
  );
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  let recordingDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--recording") throw new Error(`Unknown Relay replay generator argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--recording requires a directory");
    recordingDir = path.resolve(value);
    index += 1;
  }
  const outputPath = path.join(repoRoot, "admin-console", "public", "relay", "replay.json");
  const replay = recordingDir
    ? await createRelayUiReplayFromRecording(recordingDir, repoRoot)
    : createRelayUiReplay();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
