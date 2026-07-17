(function attachRelayModel(globalScope) {
  "use strict";

  const SIGNIFICANT_EVENTS = new Set([
    "mission_started",
    "belief_observed",
    "conflict_detected",
    "test_result",
    "correction_proposed",
    "correction_approved",
    "decision_superseded",
    "recall_observed",
    "propagation_verified",
    "mission_completed",
  ]);
  const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/;
  const DECISION_STATUS_ORDER = Object.freeze({ active: 0, proposed: 1, superseded: 2 });

  const EVENT_META = Object.freeze({
    mission_started: { label: "Source contract", tone: "source", verb: "Mission opened" },
    belief_observed: { label: "Agent belief", tone: "belief", verb: "Belief recorded" },
    conflict_detected: { label: "Conflict", tone: "danger", verb: "Disagreement surfaced" },
    test_result: { label: "Observable proof", tone: "test", verb: "Contract executed" },
    correction_proposed: { label: "Correction", tone: "proposal", verb: "Replacement proposed" },
    correction_approved: { label: "Human gate", tone: "approval", verb: "Correction approved" },
    decision_superseded: { label: "Memory lineage", tone: "correction", verb: "Stale belief retired" },
    recall_observed: { label: "Cold-start recall", tone: "recall", verb: "New agent remembered" },
    propagation_verified: { label: "Propagation proof", tone: "success", verb: "Handoff verified" },
    mission_completed: { label: "Outcome", tone: "success", verb: "Receipt sealed" },
  });

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function requireArray(value, name) {
    if (!Array.isArray(value)) throw new Error(`Relay snapshot is missing ${name}`);
  }

  function validateSnapshot(snapshot) {
    if (!isObject(snapshot)) throw new Error("Relay snapshot must be an object");
    if (snapshot.schemaVersion !== "1") throw new Error("Unsupported Relay snapshot schema");
    if (typeof snapshot.missionId !== "string" || snapshot.missionId.length === 0) {
      throw new Error("Relay snapshot is missing missionId");
    }
    for (const name of ["agents", "decisions", "conflicts", "corrections", "tests", "propagation", "events"]) {
      requireArray(snapshot[name], name);
    }
    if (!isObject(snapshot.receipt)) throw new Error("Relay snapshot is missing receipt");
    return snapshot;
  }

  function validateReplay(replay) {
    if (!isObject(replay) || replay.schemaVersion !== "1") throw new Error("Unsupported Relay replay schema");
    if (!Array.isArray(replay.frames) || replay.frames.length === 0) throw new Error("Relay replay has no frames");
    const ids = new Set();
    let previousEventCount = -1;
    let previousEvents = [];
    for (const frame of replay.frames) {
      if (!isObject(frame) || typeof frame.id !== "string" || ids.has(frame.id)) {
        throw new Error("Relay replay frame ids must be unique strings");
      }
      ids.add(frame.id);
      const snapshot = validateSnapshot(frame.snapshot);
      if (snapshot.missionId !== replay.missionId || snapshot.namespace !== replay.namespace) {
        throw new Error("Relay replay frame identity drifted");
      }
      if (snapshot.events.length <= previousEventCount) {
        throw new Error("Relay replay frames must advance the append-only event stream");
      }
      for (let index = 0; index < previousEvents.length; index += 1) {
        if (JSON.stringify(snapshot.events[index]) !== JSON.stringify(previousEvents[index])) {
          throw new Error("Relay replay frames must preserve the append-only event prefix");
        }
      }
      const eventIds = snapshot.events.map((event) => event?.eventId);
      if (eventIds.some((eventId) => typeof eventId !== "string") || new Set(eventIds).size !== eventIds.length) {
        throw new Error("Relay replay event ids must be unique strings");
      }
      previousEventCount = snapshot.events.length;
      previousEvents = snapshot.events;
    }
    if (!ids.has(replay.initialFrameId)) throw new Error("Relay replay initial frame is missing");
    return replay;
  }

  function eventSummary(event) {
    const payload = event.payload || {};
    switch (payload.kind) {
      case "mission_started": return payload.objective;
      case "belief_observed": return payload.statement;
      case "conflict_detected": return payload.summary;
      case "test_result": return payload.summary;
      case "correction_proposed": return payload.statement;
      case "correction_approved": return payload.note || `Approved by ${payload.approvedBy?.label || "a human"}.`;
      case "decision_superseded": return `${payload.decisionId} → ${payload.replacementDecisionId}`;
      case "recall_observed": return payload.query;
      case "propagation_verified": return payload.staleDecisionAbsent
        ? "Replacement recalled; stale decision absent."
        : "Propagation could not exclude the stale decision.";
      case "mission_completed": return payload.summary;
      default: return payload.summary || payload.detail || "Relay event recorded.";
    }
  }

  function timeline(snapshot) {
    return validateSnapshot(snapshot).events
      .filter((event) => SIGNIFICANT_EVENTS.has(event.payload?.kind))
      .map((event, index) => {
        const meta = EVENT_META[event.payload.kind];
        const testTone = event.payload.kind === "test_result"
          ? (event.payload.status === "passed" ? "success" : "danger")
          : meta.tone;
        return {
          id: event.eventId,
          index,
          occurredAt: event.occurredAt,
          kind: event.payload.kind,
          label: meta.label,
          verb: meta.verb,
          tone: testTone,
          summary: eventSummary(event),
          evidence: event.payload.evidence || [],
          raw: event,
        };
      });
  }

  function chooseSlot(agent, snapshot) {
    const role = `${agent.role || ""} ${agent.label || ""}`.toLowerCase();
    if ((agent.recalls || []).length > 0 || role.includes("cold") || role.includes("review")) return "reviewer";
    if (role.includes("integration") || role.includes("verify") || role.includes("nova")) return "scout";
    if (role.includes("implement") || role.includes("build") || role.includes("atlas")) return "builder";
    const superseded = snapshot.decisions.some(
      (decision) => decision.status === "superseded" && decision.heldByAgentIds.includes(agent.agentId)
    );
    return superseded ? "builder" : "scout";
  }

  function cardForAgent(slot, agent, snapshot) {
    if (!agent) {
      const placeholders = {
        scout: { label: "Scout", role: "Source-grounded verifier" },
        builder: { label: "Builder", role: "Checkout implementation" },
        reviewer: { label: "Reviewer", role: "Cold-start handoff" },
      };
      return {
        slot,
        agentId: null,
        label: placeholders[slot].label,
        role: placeholders[slot].role,
        status: "waiting",
        statusLabel: "Awaiting dispatch",
        decision: null,
        output: null,
        recall: null,
        evidence: [],
      };
    }

    const held = snapshot.decisions
      .filter((decision) => decision.heldByAgentIds.includes(agent.agentId))
      .sort((a, b) => {
        const rankA = DECISION_STATUS_ORDER[a.status] ?? Number.MAX_SAFE_INTEGER;
        const rankB = DECISION_STATUS_ORDER[b.status] ?? Number.MAX_SAFE_INTEGER;
        if (rankA !== rankB) return rankA - rankB;
        return a.decisionId.localeCompare(b.decisionId);
      })[0] || null;
    const recall = (agent.recalls || []).at(-1) || null;
    const output = (agent.outputs || []).at(-1) || null;
    let statusLabel = agent.status;
    if (recall?.coldStart) statusLabel = "Cold-start verified";
    else if (held?.status === "superseded") statusLabel = "Belief superseded";
    else if (held) statusLabel = "Belief held";

    return {
      slot,
      agentId: agent.agentId,
      label: agent.label === agent.agentId && slot === "reviewer" ? "Orbit" : agent.label,
      role: agent.role === "Codex agent" && slot === "reviewer" ? "Cold-start reviewer" : agent.role,
      status: recall?.coldStart ? "verified" : (held?.status || agent.status),
      statusLabel,
      decision: held,
      output,
      recall,
      evidence: held?.evidence || recall?.evidence || output?.evidence || [],
    };
  }

  function agentCards(snapshot) {
    validateSnapshot(snapshot);
    const bySlot = new Map();
    for (const agent of snapshot.agents) {
      const slot = chooseSlot(agent, snapshot);
      if (!bySlot.has(slot)) bySlot.set(slot, agent);
    }
    return ["scout", "builder", "reviewer"].map((slot) => cardForAgent(slot, bySlot.get(slot), snapshot));
  }

  function currentCorrection(snapshot) {
    validateSnapshot(snapshot);
    return [...snapshot.corrections].sort((a, b) => {
      const aPending = a.status === "proposed" && !a.approvedAt;
      const bPending = b.status === "proposed" && !b.approvedAt;
      if (aPending !== bPending) return aPending ? -1 : 1;
      const aUnfinished = a.status !== "propagated";
      const bUnfinished = b.status !== "propagated";
      if (aUnfinished !== bUnfinished) return aUnfinished ? -1 : 1;
      const aProposedAt = Date.parse(a.proposedAt);
      const bProposedAt = Date.parse(b.proposedAt);
      if (Number.isFinite(aProposedAt) && Number.isFinite(bProposedAt) && aProposedAt !== bProposedAt) {
        return bProposedAt - aProposedAt;
      }
      if (Number.isFinite(aProposedAt) !== Number.isFinite(bProposedAt)) {
        return Number.isFinite(aProposedAt) ? -1 : 1;
      }
      return a.correctionId.localeCompare(b.correctionId);
    })[0] || null;
  }

  function lineage(snapshot) {
    validateSnapshot(snapshot);
    const correction = currentCorrection(snapshot);
    const stale = correction?.supersedesDecisionIds
      ?.map((decisionId) => snapshot.decisions.find((decision) => decision.decisionId === decisionId))
      .find(Boolean)
      || snapshot.decisions.find((decision) => decision.status === "superseded")
      || snapshot.decisions[0]
      || null;
    const replacement = snapshot.decisions.find((decision) => decision.decisionId === correction?.proposedDecisionId)
      || snapshot.decisions.find((decision) => decision !== stale)
      || null;
    return {
      stale,
      replacement,
      correction,
      state: correction?.status || (snapshot.conflicts.length > 0 ? "conflict" : "observing"),
    };
  }

  function phase(snapshot) {
    validateSnapshot(snapshot);
    if (snapshot.receipt.complete) return { id: "recovered", label: "Outcome recovered", tone: "success" };
    if (snapshot.status === "awaiting_approval") return { id: "approval", label: "Human decision required", tone: "approval" };
    if (snapshot.status === "correcting") return { id: "correcting", label: "Correction in flight", tone: "correction" };
    if (snapshot.status === "verified") return { id: "verified", label: "Propagation verified", tone: "success" };
    if (snapshot.tests.some((item) => item.status === "failed")) return { id: "failed", label: "Contract failing", tone: "danger" };
    if (snapshot.conflicts.some((item) => item.status === "open")) return { id: "conflict", label: "Agent conflict detected", tone: "danger" };
    if (snapshot.decisions.length > 1) return { id: "diverged", label: "Beliefs diverged", tone: "belief" };
    return { id: "observing", label: "Mission observing", tone: "source" };
  }

  function receipt(snapshot) {
    validateSnapshot(snapshot);
    const latestTest = snapshot.tests.at(-1) || null;
    const correction = currentCorrection(snapshot);
    return {
      complete: snapshot.receipt.complete === true,
      outcome: snapshot.outcome?.result || (latestTest?.status === "failed" ? "failed" : "pending"),
      eventCount: snapshot.events.length,
      correctionCount: snapshot.corrections.length,
      humanApproved: correction?.approvedBy?.kind === "human",
      propagated: snapshot.receipt.coldStartVerified === true,
      contractPassed: snapshot.receipt.passingOutcomeVerified === true,
      missingEvidence: snapshot.receipt.missingEvidence || [],
      summary: snapshot.outcome?.summary || "The receipt is still accumulating causal proof.",
    };
  }

  function collectEvidence(snapshot) {
    validateSnapshot(snapshot);
    const entries = new Map();
    const add = (evidence, context) => {
      for (const item of evidence || []) {
        const key = `${item.kind}:${item.id}:${item.capture}`;
        const existing = entries.get(key);
        if (existing) {
          if (!existing.contexts.includes(context)) existing.contexts.push(context);
        } else {
          entries.set(key, { ...item, contexts: [context] });
        }
      }
    };
    for (const decision of snapshot.decisions) add(decision.evidence, `Decision · ${decision.decisionId}`);
    for (const conflict of snapshot.conflicts) add(conflict.evidence, `Conflict · ${conflict.conflictId}`);
    for (const correction of snapshot.corrections) add(correction.evidence, `Correction · ${correction.correctionId}`);
    for (const test of snapshot.tests) add(test.evidence, `Test · ${test.status}`);
    for (const propagation of snapshot.propagation) add(propagation.evidence, "Cold-start propagation");
    for (const event of snapshot.events) add(event.payload?.evidence, `Event · ${event.payload?.kind || "unknown"}`);
    return [...entries.values()];
  }

  function captureLabel(capture) {
    if (capture === "at_action") return "Captured at action";
    if (capture === "historical_lookup") return "Recorded evidence";
    if (capture === "fixture") return "Deterministic replay fixture";
    return "Unknown capture";
  }

  function isValidActorId(value) {
    return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
  }

  function canRetainAuthenticatedPrincipal(input) {
    return input?.sameConnection === true
      && input?.priorPrincipalValid === true
      && input?.metadataInvalid !== true
      && input?.status !== 401
      && input?.status !== 403;
  }

  function isCompleteEvidenceSnapshot(snapshot) {
    validateSnapshot(snapshot);
    const bounds = snapshot.bounds;
    return snapshot.readHealth === "ok"
      && isObject(bounds)
      && bounds.truncated === false
      && bounds.corruptLines === 0
      && Number.isInteger(bounds.totalEvents)
      && Number.isInteger(bounds.returnedEvents)
      && bounds.returnedEvents === bounds.totalEvents;
  }

  function createApprovalEvent(input) {
    const correctionId = String(input?.correctionId || "").trim();
    const operatorId = String(input?.operatorId || "").trim();
    const operatorLabel = String(input?.operatorLabel || "").trim();
    const occurredAt = String(input?.occurredAt || "").trim();
    const idempotencyKey = String(input?.idempotencyKey || "").trim();
    if (!IDENTIFIER_PATTERN.test(correctionId)) {
      throw new Error("A valid correction id is required");
    }
    if (!IDENTIFIER_PATTERN.test(operatorId)) {
      throw new Error("Operator id must match the authenticated Relay principal");
    }
    if (operatorLabel.length === 0 || operatorLabel.length > 240) throw new Error("Operator label is required");
    if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Approval timestamp is invalid");
    if (!IDENTIFIER_PATTERN.test(idempotencyKey)) {
      throw new Error("Approval idempotency key is invalid");
    }
    return {
      occurredAt,
      idempotencyKey,
      payload: {
        kind: "correction_approved",
        correctionId,
        approvedBy: { kind: "human", id: operatorId, label: operatorLabel },
        note: "Approved in Remnic Relay Mission Control after reviewing the source and failing contract.",
        evidence: [{
          kind: "approval",
          id: idempotencyKey,
          label: `Mission Control approval by ${operatorLabel}`,
          locator: `relay://approvals/${idempotencyKey}`,
          capture: "at_action",
        }],
      },
    };
  }

  function isReusableApprovalEvent(candidate, correctionId, operatorId) {
    if (!isObject(candidate) || !isObject(candidate.payload)) return false;
    const payload = candidate.payload;
    return payload.kind === "correction_approved"
      && payload.correctionId === correctionId
      && payload.approvedBy?.kind === "human"
      && IDENTIFIER_PATTERN.test(payload.approvedBy.id || "")
      && (operatorId === undefined || payload.approvedBy.id === operatorId)
      && typeof payload.approvedBy.label === "string"
      && IDENTIFIER_PATTERN.test(candidate.idempotencyKey || "")
      && Number.isFinite(Date.parse(candidate.occurredAt))
      && Array.isArray(payload.evidence)
      && payload.evidence.some((item) =>
        item?.kind === "approval"
        && item.capture === "at_action"
        && IDENTIFIER_PATTERN.test(item.id || "")
      );
  }

  globalScope.RelayModel = Object.freeze({
    agentCards,
    canRetainAuthenticatedPrincipal,
    captureLabel,
    collectEvidence,
    createApprovalEvent,
    currentCorrection,
    isCompleteEvidenceSnapshot,
    isValidActorId,
    isReusableApprovalEvent,
    lineage,
    phase,
    receipt,
    timeline,
    validateReplay,
    validateSnapshot,
  });
})(globalThis);
