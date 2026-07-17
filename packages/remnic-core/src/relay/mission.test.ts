import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RELAY_DEMO_MISSION_ID, RELAY_DEMO_NAMESPACE, createRelayMissionFixture } from "./mission-fixture.js";
import {
  type RelayMissionEvent,
  RelayMissionEventInputSchema,
  RelayMissionEventSchema,
  RelayMissionStore,
  RelayMissionStoreError,
  reduceRelayMission,
  relayMissionReceiptDigest,
} from "./mission.js";

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

function fixtureEvents(): RelayMissionEvent[] {
  return createRelayMissionFixture().map((input, index) =>
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
}

function firstFixtureInput() {
  const [first] = createRelayMissionFixture();
  if (!first) throw new Error("Relay mission fixture must contain a start event");
  return first;
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
    assert.equal(snapshot.corrections[0]?.appliedAt, "2026-07-17T18:00:23.000Z");
    assert.equal(snapshot.agents.find((agent) => agent.agentId === "agent-orbit")?.recalls[0]?.coldStart, true);
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

test("a rejected append hook does not poison the mission mutation chain", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    const first = firstFixtureInput();
    await assert.rejects(
      store.append(RELAY_DEMO_MISSION_ID, first, {
        beforeAppend: () => {
          throw new Error("quota rejected");
        },
      }),
      /quota rejected/
    );
    const recovered = await store.append(RELAY_DEMO_MISSION_ID, first);
    assert.equal(recovered.appended, true);
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

    const outsideWindow = await store.read(RELAY_DEMO_MISSION_ID, {
      since: "2026-07-17T19:00:00.000Z",
      limit: 1,
    });
    assert.equal(outsideWindow.found, true, "a known mission remains found outside the selected window");
    assert.equal(outsideWindow.bounds.totalEvents, 0);
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
  assert.equal(
    RelayMissionEventInputSchema.safeParse({
      ...recall,
      payload: {
        ...recall.payload,
        evidence: recall.payload.evidence.map((item) => ({
          ...item,
          id: "different-recall-receipt",
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
    payload: firstFixtureInput().payload,
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

test("reducer sorts offset timestamps by instant before applying state transitions", () => {
  const base = {
    schemaVersion: "1" as const,
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    recordedAt: "2026-07-17T16:00:00.000Z",
    payload: firstFixtureInput().payload,
  };
  const events: RelayMissionEvent[] = [
    { ...base, eventId: "event-later", occurredAt: "2026-07-17T10:00:00.000-05:00" },
    { ...base, eventId: "event-earlier", occurredAt: "2026-07-17T14:00:00.000Z" },
  ];
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events,
  });
  assert.deepEqual(
    snapshot.events.map((event) => event.eventId),
    ["event-earlier", "event-later"]
  );
});

test("time windows filter the event feed without rewriting authoritative receipt state", () => {
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: fixtureEvents(),
    options: { since: "2026-07-17T19:00:00.000Z", limit: 1 },
  });

  assert.equal(snapshot.found, true);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.receipt.complete, true);
  assert.equal(snapshot.bounds.totalEvents, 0);
  assert.equal(snapshot.bounds.returnedEvents, 0);
  assert.deepEqual(snapshot.events, []);
});

test("receipt requires an observed, decision-linked conflict and coherent mission lifecycle", () => {
  const withoutConflict = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: fixtureEvents().filter((event) => event.payload.kind !== "conflict_detected"),
  });
  assert.equal(withoutConflict.receipt.complete, false);
  assert.deepEqual(withoutConflict.conflicts, []);
  assert.ok(withoutConflict.receipt.missingEvidence.includes("conflict:conflict-token-lifecycle:observation"));

  const lateStart = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: fixtureEvents().map((event) =>
      event.payload.kind === "mission_started" ? { ...event, occurredAt: "2026-07-17T18:00:40.000Z" } : event
    ),
  });
  assert.equal(lateStart.status, "active");
  assert.equal(lateStart.receipt.complete, false);
  assert.ok(lateStart.receipt.missingEvidence.includes("mission:lifecycle-order"));
  assert.ok(lateStart.receipt.missingEvidence.some((item) => item.startsWith("mission:event-before-start:")));
  assert.deepEqual(lateStart.decisions, []);
  assert.equal(lateStart.outcome, null);

  const [start, firstEvidence, ...remainingEvents] = fixtureEvents();
  assert.ok(start && firstEvidence);
  const appendedBeforeStart = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: [firstEvidence, start, ...remainingEvents],
  });
  assert.equal(appendedBeforeStart.receipt.complete, false);
  assert.ok(
    appendedBeforeStart.receipt.missingEvidence.includes(`mission:event-before-start:${firstEvidence.eventId}`)
  );
});

test("a correction must account for every decision in its observed conflict", () => {
  const events = fixtureEvents();
  const belief = events.find((event) => event.payload.kind === "belief_observed");
  assert.ok(belief && belief.payload.kind === "belief_observed");
  const thirdDecision: RelayMissionEvent = RelayMissionEventSchema.parse({
    ...belief,
    eventId: "fixture-event-third-conflict",
    recordedAt: "2026-07-17T18:00:11.000Z",
    occurredAt: "2026-07-17T18:00:11.000Z",
    payload: {
      ...belief.payload,
      beliefId: "belief-static-token",
      decisionId: "decision-use-static-token",
      statement: "Reuse one static token indefinitely.",
    },
  });
  const incompleteConflict = events.map((event) =>
    event.payload.kind === "conflict_detected"
      ? {
          ...event,
          payload: {
            ...event.payload,
            decisionIds: [...event.payload.decisionIds, "decision-use-static-token"],
          },
        }
      : event
  );
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: [...incompleteConflict, thirdDecision],
  });

  assert.equal(snapshot.receipt.complete, false);
  assert.deepEqual(snapshot.receipt.supersededDecisionIds, []);
  assert.equal(snapshot.conflicts[0]?.status, "open");
  assert.equal(snapshot.corrections[0]?.status, "approved");
  assert.ok(snapshot.receipt.missingEvidence.includes("conflict:conflict-token-lifecycle:decision-link"));
});

test("a recovered correction must share source evidence with its observed conflict", () => {
  const withoutSources = fixtureEvents().map((event) =>
    RelayMissionEventSchema.parse({
      ...event,
      payload: {
        ...event.payload,
        evidence: event.payload.evidence.map((item) =>
          item.kind === "source" ? { ...item, kind: "test" as const } : item
        ),
      },
    })
  );
  const ungrounded = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: withoutSources,
  });

  assert.equal(ungrounded.receipt.complete, false);
  assert.deepEqual(ungrounded.receipt.supersededDecisionIds, []);
  assert.equal(ungrounded.conflicts[0]?.status, "open");
  assert.ok(ungrounded.receipt.missingEvidence.includes("conflict:conflict-token-lifecycle:source"));
  assert.ok(ungrounded.receipt.missingEvidence.includes("correction:correction-token-refresh:source"));
  assert.ok(ungrounded.receipt.missingEvidence.includes("correction:correction-token-refresh:source-link"));

  const mismatchedSource = fixtureEvents().map((event) =>
    event.payload.kind === "correction_proposed"
      ? RelayMissionEventSchema.parse({
          ...event,
          payload: {
            ...event.payload,
            evidence: event.payload.evidence.map((item) =>
              item.kind === "source" ? { ...item, id: "source-unrelated-contract" } : item
            ),
          },
        })
      : event
  );
  const unlinked = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: mismatchedSource,
  });
  assert.equal(unlinked.receipt.complete, false);
  assert.ok(unlinked.receipt.missingEvidence.includes("correction:correction-token-refresh:source-link"));
});

test("events after completion cannot rewrite the terminal mission snapshot", () => {
  const events = fixtureEvents();
  const proposal = events.find((event) => event.payload.kind === "correction_proposed");
  assert.ok(proposal && proposal.payload.kind === "correction_proposed");
  const postCompletionProposal: RelayMissionEvent = RelayMissionEventSchema.parse({
    ...proposal,
    eventId: "fixture-event-after-completion",
    recordedAt: "2026-07-17T18:00:40.000Z",
    occurredAt: "2026-07-17T18:00:40.000Z",
    payload: {
      ...proposal.payload,
      correctionId: "correction-after-completion",
    },
  });
  const backdatedPostCompletionProposal: RelayMissionEvent = RelayMissionEventSchema.parse({
    ...proposal,
    eventId: "fixture-event-backdated-after-completion",
    recordedAt: "2026-07-17T18:00:41.000Z",
    occurredAt: "2026-07-17T18:00:20.000Z",
    payload: {
      ...proposal.payload,
      correctionId: "correction-backdated-after-completion",
    },
  });
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: [...events, postCompletionProposal, backdatedPostCompletionProposal],
  });

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.outcome?.result, "recovered");
  assert.equal(snapshot.corrections.length, 1);
  assert.equal(snapshot.corrections[0]?.status, "propagated");
  assert.equal(snapshot.receipt.complete, false);
  assert.ok(snapshot.receipt.missingEvidence.includes("mission:event-after-completion:fixture-event-after-completion"));
  assert.ok(
    snapshot.receipt.missingEvidence.includes("mission:event-after-completion:fixture-event-backdated-after-completion")
  );
});

test("propagation requires a matching post-application recall from a cold agent session", () => {
  const recallBeforeApplication = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: fixtureEvents().map((event) =>
      event.payload.kind === "recall_observed" ? { ...event, occurredAt: "2026-07-17T18:00:22.000Z" } : event
    ),
  });
  assert.equal(recallBeforeApplication.receipt.complete, false);
  assert.equal(recallBeforeApplication.receipt.coldStartVerified, false);
  assert.ok(recallBeforeApplication.receipt.missingEvidence.includes("recall:recall-orbit-cold:post-application"));

  const warmAgent = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: fixtureEvents().map((event) => {
      if (event.payload.kind !== "recall_observed" && event.payload.kind !== "propagation_verified") return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          agentId: "agent-atlas",
          sessionId: "session-atlas",
        },
      };
    }),
  });
  assert.equal(warmAgent.receipt.complete, false);
  assert.equal(warmAgent.receipt.coldStartVerified, false);
  assert.ok(warmAgent.receipt.missingEvidence.includes("recall:recall-orbit-cold:cold-start"));
});

test("receipt cannot apply or propagate a correction without prior approval", () => {
  const events = fixtureEvents().filter((event) => event.payload.kind !== "correction_approved");
  const snapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events,
  });

  assert.equal(snapshot.receipt.complete, false);
  assert.equal(snapshot.receipt.coldStartVerified, false);
  assert.deepEqual(snapshot.receipt.supersededDecisionIds, []);
  assert.equal(
    snapshot.decisions.find((decision) => decision.decisionId === "decision-new-token-every-request")?.status,
    "active"
  );
  assert.equal(snapshot.corrections[0]?.status, "proposed");
  assert.ok(snapshot.receipt.missingEvidence.includes("correction:correction-token-refresh:approval"));
});

test("receipt requires human approval and a passing test after verified propagation", () => {
  const agentApproved = fixtureEvents().map((event) =>
    event.payload.kind === "correction_approved"
      ? {
          ...event,
          payload: {
            ...event.payload,
            approvedBy: { kind: "agent" as const, id: "policy-agent", label: "Policy agent" },
          },
        }
      : event
  );
  const agentApprovedSnapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: agentApproved,
  });
  assert.equal(agentApprovedSnapshot.receipt.complete, false);
  assert.ok(
    agentApprovedSnapshot.receipt.missingEvidence.includes("correction:correction-token-refresh:human-approval")
  );

  const passBeforePropagation = fixtureEvents().map((event) =>
    event.payload.kind === "test_result" && event.payload.status === "passed"
      ? { ...event, occurredAt: "2026-07-17T18:00:11.500Z" }
      : event
  );
  const earlyPassSnapshot = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events: passBeforePropagation,
  });
  assert.equal(earlyPassSnapshot.receipt.complete, false);
  assert.equal(earlyPassSnapshot.receipt.passingOutcomeVerified, false);
  assert.ok(earlyPassSnapshot.receipt.missingEvidence.includes("outcome:passing-test"));
});

test("missing evidence is explicit rather than conflated with a complete receipt", () => {
  const input = firstFixtureInput();
  assert.ok(input.occurredAt);
  const event: RelayMissionEvent = {
    schemaVersion: "1",
    eventId: "event-no-evidence",
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    recordedAt: input.occurredAt,
    occurredAt: input.occurredAt,
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
    const [first, second] = createRelayMissionFixture();
    assert.ok(first && second);
    await bounded.append(RELAY_DEMO_MISSION_ID, first);
    await assert.rejects(
      bounded.append(RELAY_DEMO_MISSION_ID, second),
      (error: unknown) => error instanceof RelayMissionStoreError && error.code === "limit_exceeded"
    );
  });
});

test("mission identifiers cannot traverse the storage root", async () => {
  await withTempRoot(async (root) => {
    const store = deterministicStore(root);
    await assert.rejects(store.read("../production"));
    await assert.rejects(store.append("bad/id", firstFixtureInput()));
  });
});
