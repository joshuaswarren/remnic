import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RelayMissionEventInputSchema,
  RelayMissionStore,
  RelayMissionStoreError,
  reduceRelayMission,
  relayMissionReceiptDigest,
  type RelayMissionEvent,
} from "./mission.js";
import { createRelayMissionFixture, RELAY_DEMO_MISSION_ID, RELAY_DEMO_NAMESPACE } from "./mission-fixture.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deterministicStore(root: string, options: { maxEvents?: number } = {}): RelayMissionStore {
  let nextId = 0;
  return new RelayMissionStore({
    rootDir: root,
    namespace: RELAY_DEMO_NAMESPACE,
    now: () => new Date("2026-07-17T19:00:00.000Z"),
    createEventId: () => `event-${String(++nextId).padStart(3, "0")}`,
    ...options,
  });
}

test("fixture reduces to a complete correction and cold-start receipt", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    for (const input of createRelayMissionFixture()) {
      const result = await store.append(RELAY_DEMO_MISSION_ID, input);
      assert.equal(result.appended, true);
      assert.equal(result.replayed, false);
    }

    const snapshot = await store.read(RELAY_DEMO_MISSION_ID);
    assert.equal(snapshot.found, true);
    assert.equal(snapshot.readHealth, "ok");
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.events.length, 16);
    assert.deepEqual(snapshot.receipt.activeDecisionIds, ["decision-refresh-after-expiry"]);
    assert.deepEqual(snapshot.receipt.supersededDecisionIds, ["decision-new-token-every-request"]);
    assert.equal(snapshot.receipt.coldStartVerified, true);
    assert.equal(snapshot.receipt.passingOutcomeVerified, true);
    assert.deepEqual(snapshot.receipt.missingEvidence, []);
    assert.equal(snapshot.receipt.complete, true);
    assert.equal(snapshot.corrections[0]?.status, "propagated");
    assert.equal(
      snapshot.decisions.find((item) => item.status === "superseded")?.supersededBy,
      "decision-refresh-after-expiry"
    );

    const digest = relayMissionReceiptDigest(snapshot);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(digest, relayMissionReceiptDigest(await store.read(RELAY_DEMO_MISSION_ID)));

    const mode = await readFile(path.join(root, "state", "relay", "missions", `${RELAY_DEMO_MISSION_ID}.jsonl`));
    assert.ok(mode.length > 0);
  });
});

test("idempotent append replays matching input and rejects conflicting input", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    const [first] = createRelayMissionFixture();
    assert.ok(first);
    assert.equal(first.payload.kind, "mission_started");
    if (first.payload.kind !== "mission_started") throw new Error("fixture contract drift");
    const initial = await store.append(RELAY_DEMO_MISSION_ID, first);
    const replay = await store.append(RELAY_DEMO_MISSION_ID, first);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.eventId, initial.event.eventId);

    await assert.rejects(
      store.append(RELAY_DEMO_MISSION_ID, {
        ...first,
        payload: { ...first.payload, title: "Different mission" },
      }),
      (error: unknown) => error instanceof RelayMissionStoreError && error.code === "idempotency_conflict"
    );
  });
});

test("empty, partial, and bounded reads remain distinct and deterministic", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    const empty = await store.read(RELAY_DEMO_MISSION_ID);
    assert.equal(empty.found, false);
    assert.equal(empty.readHealth, "empty");
    assert.equal(empty.status, "not_started");

    for (const input of createRelayMissionFixture().slice(0, 3)) {
      await store.append(RELAY_DEMO_MISSION_ID, input);
    }
    const file = path.join(root, "state", "relay", "missions", `${RELAY_DEMO_MISSION_ID}.jsonl`);
    await writeFile(file, `${await readFile(file, "utf8")}not-json\n`, { mode: 0o600 });

    const partial = await store.read(RELAY_DEMO_MISSION_ID, {
      since: "2026-07-17T18:00:02.000Z",
      until: "2026-07-17T18:00:03.000Z",
      limit: 1,
    });
    assert.equal(partial.readHealth, "partial");
    assert.equal(partial.bounds.corruptLines, 1);
    assert.equal(partial.bounds.totalEvents, 1);
    assert.equal(partial.events[0]?.payload.kind, "agent_status");
    assert.equal(partial.events[0]?.occurredAt, "2026-07-17T18:00:02.000Z");
  });
});

test("event contract rejects invalid identifiers, self-supersession, and mislabeled recall", () => {
  const fixture = createRelayMissionFixture();
  assert.throws(() => new RelayMissionStore({ rootDir: "/tmp", namespace: "" }));
  assert.equal(
    RelayMissionEventInputSchema.safeParse({
      occurredAt: "2026-07-17T18:00:00.000Z",
      payload: {
        kind: "decision_superseded",
        decisionId: "same",
        replacementDecisionId: "same",
        correctionId: "correction",
        evidence: [],
      },
    }).success,
    false
  );
  const recall = fixture.find((item) => item.payload.kind === "recall_observed");
  assert.ok(recall && recall.payload.kind === "recall_observed");
  assert.equal(
    RelayMissionEventInputSchema.safeParse({
      ...recall,
      payload: {
        ...recall.payload,
        evidence: recall.payload.evidence.map((item) => ({
          ...item,
          capture: "historical_lookup" as const,
        })),
      },
    }).success,
    false
  );
});

test("reducer sorts equal-time events with a stable event-id tie break", () => {
  const base = {
    schemaVersion: "1" as const,
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    recordedAt: "2026-07-17T18:00:00.000Z",
    occurredAt: "2026-07-17T18:00:00.000Z",
    payload: createRelayMissionFixture()[0]!.payload,
  };
  const events: RelayMissionEvent[] = [
    { ...base, eventId: "event-b" },
    { ...base, eventId: "event-a" },
  ];
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events,
  });
  assert.deepEqual(
    snapshot.events.map((event) => event.eventId),
    ["event-a", "event-b"]
  );
});

test("missing evidence is explicit rather than conflated with a complete receipt", () => {
  const input = createRelayMissionFixture()[0]!;
  const event: RelayMissionEvent = {
    schemaVersion: "1",
    eventId: "event-no-evidence",
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    recordedAt: input.occurredAt!,
    occurredAt: input.occurredAt!,
    payload: { ...input.payload, evidence: [] },
  };
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: [event],
  });
  assert.equal(snapshot.receipt.complete, false);
  assert.deepEqual(snapshot.receipt.missingEvidence, ["event:event-no-evidence:evidence"]);
});

test("store rejects a symlinked Relay directory and event-count overflow", async () => {
  await withTempRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-outside-"));
    try {
      await symlink(outside, path.join(root, "state"));
      const unsafe = deterministicStore(root);
      await assert.rejects(
        unsafe.read(RELAY_DEMO_MISSION_ID),
        (error: unknown) => error instanceof RelayMissionStoreError && error.code === "unsafe_path"
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  await withTempRoot(async (root) => {
    const bounded = deterministicStore(root, { maxEvents: 1 });
    const fixture = createRelayMissionFixture();
    await bounded.append(RELAY_DEMO_MISSION_ID, fixture[0]!);
    await assert.rejects(
      bounded.append(RELAY_DEMO_MISSION_ID, fixture[1]!),
      (error: unknown) => error instanceof RelayMissionStoreError && error.code === "limit_exceeded"
    );
  });
});

test("mission identifiers cannot traverse the storage root", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    await assert.rejects(store.read("../production"));
    await assert.rejects(store.append("bad/id", createRelayMissionFixture()[0]!));
  });
});
