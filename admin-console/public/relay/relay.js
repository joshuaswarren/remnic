(function runRelayMissionControl() {
  "use strict";

  const Model = globalThis.RelayModel;
  if (!Model) throw new Error("RelayModel failed to load");

  const element = (id) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Mission Control element #${id} is missing`);
    return found;
  };

  const dom = {
    modePill: element("modePill"), missionCode: element("missionCode"), stateBanner: element("stateBanner"),
    frameCounter: element("frameCounter"), missionTitle: element("missionTitle"), missionObjective: element("missionObjective"),
    phaseBeacon: element("phaseBeacon"), phaseLabel: element("phaseLabel"), phaseDetail: element("phaseDetail"),
    frameLabel: element("frameLabel"), speedSelect: element("speedSelect"), restartButton: element("restartButton"),
    previousButton: element("previousButton"), playButton: element("playButton"), nextButton: element("nextButton"),
    replayProgress: element("replayProgress"), lineage: element("lineage"), lineageStatus: element("lineageStatus"),
    staleBelief: element("staleBelief"), replacementBelief: element("replacementBelief"), transferLabel: element("transferLabel"),
    correctionGate: element("correctionGate"), gateCopy: element("gateCopy"), approveButton: element("approveButton"),
    receiptSeal: element("receiptSeal"), receiptSummary: element("receiptSummary"), receiptApproval: element("receiptApproval"),
    receiptPropagation: element("receiptPropagation"), receiptContract: element("receiptContract"), receiptEvents: element("receiptEvents"),
    outcomeShift: element("outcomeShift"), agentGrid: element("agentGrid"), eventRail: element("eventRail"),
    dataProvenance: element("dataProvenance"), provenanceDrawer: element("provenanceDrawer"), drawerScrim: element("drawerScrim"),
    drawerTitle: element("drawerTitle"), drawerContext: element("drawerContext"), evidenceList: element("evidenceList"),
    freshInspectionButton: element("freshInspectionButton"), freshInspectionResult: element("freshInspectionResult"),
    closeDrawerButton: element("closeDrawerButton"), evidenceIndexButton: element("evidenceIndexButton"), connectButton: element("connectButton"),
    approvalDialog: element("approvalDialog"), approvalForm: element("approvalForm"), approvalModeLabel: element("approvalModeLabel"),
    approvalTitle: element("approvalTitle"), approvalLede: element("approvalLede"), approvalRetireStatements: element("approvalRetireStatements"),
    approvalReplacementStatement: element("approvalReplacementStatement"), approvalEvidence: element("approvalEvidence"),
    liveIdentityFields: element("liveIdentityFields"), operatorIdInput: element("operatorIdInput"), operatorLabelInput: element("operatorLabelInput"),
    approvalConfirmInput: element("approvalConfirmInput"), confirmApprovalButton: element("confirmApprovalButton"),
    approvalError: element("approvalError"), approvalFootnote: element("approvalFootnote"),
    connectionDialog: element("connectionDialog"), connectionForm: element("connectionForm"), missionInput: element("missionInput"),
    namespaceInput: element("namespaceInput"), tokenInput: element("tokenInput"), connectionError: element("connectionError"),
    loadingScreen: element("loadingScreen"), toast: element("toast"),
  };

  const TOKEN_KEY = "remnic-relay-live-token";
  const state = {
    mode: "replay",
    replay: null,
    frameIndex: 0,
    snapshot: null,
    playing: false,
    timer: null,
    speed: 1,
    replayApprovalGranted: false,
    resumeAfterApproval: false,
    missionId: "checkout-token-recovery",
    namespace: "relay-build-week",
    token: "",
    authenticatedPrincipal: "",
    authenticatedContext: null,
    connectionGeneration: 0,
    connectionRequestId: 0,
    liveReadRequestId: 0,
    approvalRequestId: 0,
    approvalReviewKey: "",
    drawer: null,
    drawerInvoker: null,
    lastAgentIds: new Set(),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeSessionGet(key) {
    try { return window.sessionStorage.getItem(key) || ""; } catch { return ""; }
  }

  function safeSessionSet(key, value) {
    try { window.sessionStorage.setItem(key, value); return true; } catch { return false; }
  }

  function safeSessionRemove(key) {
    try { window.sessionStorage.removeItem(key); } catch { /* best effort */ }
  }

  function setBanner(message, tone = "") {
    dom.stateBanner.textContent = message;
    dom.stateBanner.className = `state-banner ${tone}`.trim();
    dom.stateBanner.hidden = !message;
  }

  let toastTimer = null;
  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 3_600);
  }

  function phaseDetail(phaseId) {
    const details = {
      observing: "Relay is assembling the team and the evidence boundary.",
      diverged: "The same mission now contains incompatible agent beliefs.",
      conflict: "Two agents. Two incompatible beliefs. One observable contract.",
      failed: "The stale belief produced a concrete integration failure.",
      approval: "Source and test agree; shared memory waits for a human.",
      correcting: "The stale decision is retiring across the mission lineage.",
      verified: "A cold-start agent recalled the replacement without the stale belief.",
      recovered: "Human-approved memory changed the observable team outcome.",
    };
    return details[phaseId] || "Relay is reconstructing the causal trace.";
  }

  function agentName(agentId) {
    const agent = state.snapshot?.agents.find((item) => item.agentId === agentId);
    if (!agent) return agentId || "Agent";
    if (agent.label === agent.agentId && (agent.recalls || []).some((recall) => recall.coldStart)) return "Orbit";
    return agent.label;
  }

  function setBelief(article, decision, fallback, owner, stateLabel) {
    article.querySelector(".belief-owner").textContent = owner;
    article.querySelector(".belief-state").textContent = stateLabel;
    article.querySelector("blockquote").textContent = decision?.statement || fallback;
    const button = article.querySelector(".evidence-link");
    const holder = decision?.heldByAgentIds?.[0];
    if (holder) {
      button.dataset.agentId = holder;
      button.disabled = false;
    } else {
      button.disabled = true;
    }
  }

  function renderLineage(snapshot) {
    const view = Model.lineage(snapshot);
    const applied = Boolean(view.stale?.status === "superseded" || view.correction?.appliedAt);
    const propagated = Boolean(view.correction?.propagatedAt);
    const staleHolder = view.stale?.heldByAgentIds?.[0];
    const replacementHolder = view.replacement?.heldByAgentIds?.[0];
    setBelief(
      dom.staleBelief,
      view.stale,
      "Waiting for the builder's implementation belief…",
      staleHolder ? `BUILDER · ${agentName(staleHolder).toUpperCase()}` : "BUILDER · WAITING",
      applied ? "SUPERSEDED" : "ACTIVE BELIEF"
    );
    setBelief(
      dom.replacementBelief,
      view.replacement,
      "Waiting for the scout's source-grounded belief…",
      replacementHolder ? `SCOUT · ${agentName(replacementHolder).toUpperCase()}` : "SCOUT · WAITING",
      applied ? "ACTIVE REPLACEMENT" : "SOURCE-GROUNDED"
    );
    dom.staleBelief.classList.toggle("superseded", applied);
    dom.replacementBelief.classList.toggle("activated", applied);
    dom.lineage.classList.toggle("resolved", applied);

    const statusByState = {
      observing: "OBSERVING",
      conflict: "CONFLICT OPEN",
      proposed: "HUMAN GATE",
      approved: "APPROVED",
      applied: "BELIEF RETIRED",
      propagated: "PROPAGATED",
    };
    const status = propagated ? "PROPAGATED" : (statusByState[view.state] || String(view.state).toUpperCase());
    dom.lineageStatus.textContent = status;
    dom.lineageStatus.className = `stage-status ${propagated || applied ? "success" : view.state === "proposed" ? "approval" : ""}`.trim();
    dom.transferLabel.textContent = propagated
      ? "COLD-START HANDOFF VERIFIED"
      : applied
        ? "STALE → SUPERSEDED"
        : view.correction
          ? "CORRECTION READY"
          : snapshot.conflicts.length > 0
            ? "DISAGREEMENT DETECTED"
            : "BELIEFS FORMING";

    const requiresApproval = Boolean(view.correction && !view.correction.approvedAt);
    dom.correctionGate.hidden = !requiresApproval;
    if (requiresApproval) {
      const livePrincipalReady = Model.isValidActorId(state.authenticatedPrincipal);
      const evidenceComplete = Model.isCompleteEvidenceSnapshot(snapshot);
      dom.gateCopy.textContent = state.mode !== "live"
        ? "Playback pauses here. Cross the explicit human gate to continue the integrity-checked replay."
        : !evidenceComplete
          ? "Live approval is disabled: this snapshot is partial, truncated, corrupt, or otherwise incomplete."
          : livePrincipalReady
            ? `This write changes shared mission state as server-authenticated principal ${state.authenticatedPrincipal}.`
            : "Live approval is disabled: this Relay server did not resolve a valid authenticated principal.";
      dom.approveButton.textContent = state.mode === "live" ? "Approve correction" : "Review correction";
      dom.approveButton.disabled = state.mode === "live" && (!livePrincipalReady || !evidenceComplete);
    }
  }

  function statusText(card) {
    if (card.status === "waiting") return "Awaiting dispatch";
    if (card.status === "verified") return "Cold-start verified";
    if (card.status === "superseded") return "Belief superseded";
    return card.statusLabel || card.status;
  }

  function renderAgents(snapshot) {
    const cards = Model.agentCards(snapshot);
    dom.agentGrid.innerHTML = cards.map((card, index) => {
      const isNew = card.agentId && !state.lastAgentIds.has(card.agentId);
      const cardClass = ["agent-card", card.status, isNew ? "is-new" : ""].filter(Boolean).join(" ");
      const belief = card.decision?.statement
        || card.recall?.query
        || card.output?.summary
        || "Waiting for mission evidence…";
      const beliefLabel = card.recall?.coldStart ? "Cold-start recall" : card.decision ? "Current belief" : card.output ? "Latest output" : "Mission state";
      const evidenceCount = card.evidence.length;
      return `<article class="${escapeHtml(cardClass)}">
        <div class="agent-top">
          <span class="agent-index">0${index + 1} / ${escapeHtml(card.slot)}</span>
          <span class="agent-status">${escapeHtml(statusText(card))}</span>
        </div>
        <h3>${escapeHtml(card.label)}</h3>
        <p class="agent-role">${escapeHtml(card.role)}</p>
        <div class="agent-belief"><span>${escapeHtml(beliefLabel)}</span><p>${escapeHtml(belief)}</p></div>
        <div class="agent-evidence">
          <small>${String(evidenceCount).padStart(2, "0")} EVIDENCE REF${evidenceCount === 1 ? "" : "S"}</small>
          <button type="button" data-agent-id="${escapeHtml(card.agentId || "")}" ${card.agentId ? "" : "disabled"}>X-ray belief ↗</button>
        </div>
      </article>`;
    }).join("");
    state.lastAgentIds = new Set(cards.flatMap((card) => card.agentId ? [card.agentId] : []));
  }

  function formatTraceTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return date.toISOString().slice(11, 19) + "Z";
  }

  function renderTimeline(snapshot) {
    const events = Model.timeline(snapshot);
    dom.eventRail.innerHTML = events.map((event) => `<li class="event-item ${escapeHtml(event.tone)}">
      <button type="button" data-event-id="${escapeHtml(event.id)}" aria-label="Inspect evidence for ${escapeHtml(event.verb)}">
        <time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(formatTraceTime(event.occurredAt))}</time>
        <strong>${escapeHtml(event.verb)}</strong>
        <p>${escapeHtml(event.summary)}</p>
      </button>
    </li>`).join("");
    requestAnimationFrame(() => { dom.eventRail.scrollLeft = dom.eventRail.scrollWidth; });
  }

  function setReceiptValue(node, yes, positive, negative = "PENDING") {
    node.textContent = yes ? positive : negative;
    node.className = yes ? "yes" : "";
  }

  function renderReceipt(snapshot) {
    const receipt = Model.receipt(snapshot);
    dom.receiptSeal.classList.toggle("complete", receipt.complete);
    dom.receiptSeal.setAttribute("aria-label", receipt.complete ? "Receipt complete" : "Receipt pending");
    dom.receiptSeal.querySelector("small").textContent = receipt.complete ? "SEALED" : "PENDING";
    dom.receiptSummary.textContent = receipt.summary;
    setReceiptValue(dom.receiptApproval, receipt.humanApproved, "VERIFIED");
    setReceiptValue(dom.receiptPropagation, receipt.propagated, "VERIFIED");
    setReceiptValue(dom.receiptContract, receipt.contractPassed, "PASSED", snapshot.tests.some((test) => test.status === "failed") ? "FAILED" : "PENDING");
    if (snapshot.tests.some((test) => test.status === "failed") && !receipt.contractPassed) dom.receiptContract.className = "no";
    dom.receiptEvents.textContent = String(receipt.eventCount).padStart(2, "0");
    const firstTest = snapshot.tests[0];
    const latestTest = snapshot.tests.at(-1);
    dom.outcomeShift.innerHTML = `
      <span class="outcome-before ${firstTest?.status === "failed" ? "failed" : ""}"><i></i> BEFORE · ${escapeHtml(firstTest?.status?.toUpperCase() || "TEST WAITING")}</span>
      <span class="outcome-arrow" aria-hidden="true">→</span>
      <span class="outcome-after ${latestTest?.status === "passed" ? "passed" : ""}"><i></i> AFTER · ${escapeHtml(latestTest?.status === "passed" ? "CONTRACT PASSED" : "PROOF PENDING")}</span>`;
  }

  function renderControls() {
    const replayMode = state.mode === "replay";
    const frame = state.replay?.frames[state.frameIndex];
    const total = state.replay?.frames.length || 1;
    dom.frameCounter.textContent = replayMode ? `${String(state.frameIndex + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : "LIVE / NOW";
    dom.frameLabel.textContent = replayMode ? (frame?.label || "Replay") : "Live mission snapshot";
    dom.replayProgress.style.width = replayMode ? `${((state.frameIndex + 1) / total) * 100}%` : "100%";
    dom.restartButton.disabled = !replayMode;
    dom.previousButton.disabled = !replayMode || state.frameIndex <= 0;
    dom.nextButton.disabled = !replayMode || state.frameIndex >= total - 1;
    dom.speedSelect.disabled = !replayMode;
    dom.playButton.innerHTML = replayMode
      ? `<span aria-hidden="true">${state.playing ? "Ⅱ" : "▶"}</span> ${state.playing ? "Pause trace" : "Play trace"}`
      : `<span aria-hidden="true">↻</span> Refresh live`;
    dom.playButton.setAttribute("aria-label", replayMode ? (state.playing ? "Pause replay" : "Play replay") : "Refresh live mission");
  }

  function render() {
    if (!state.snapshot) return;
    const snapshot = Model.validateSnapshot(state.snapshot);
    const currentPhase = Model.phase(snapshot);
    dom.modePill.className = `mode-pill ${state.mode === "live" ? "live" : ""}`.trim();
    dom.modePill.innerHTML = `<i aria-hidden="true"></i> ${state.mode === "live" ? "Live API" : "Replay"}`;
    dom.missionCode.textContent = snapshot.missionId.toUpperCase();
    dom.missionTitle.textContent = snapshot.mission?.title || "Unstarted Relay mission";
    dom.missionObjective.textContent = snapshot.mission?.objective || "Waiting for the first mission event.";
    dom.phaseLabel.textContent = currentPhase.label;
    dom.phaseDetail.textContent = phaseDetail(currentPhase.id);
    dom.phaseBeacon.className = `phase-beacon ${currentPhase.tone === "success" ? "success" : currentPhase.tone === "approval" ? "approval" : ""}`.trim();
    renderControls();
    renderLineage(snapshot);
    renderReceipt(snapshot);
    renderAgents(snapshot);
    renderTimeline(snapshot);
    if (dom.approvalDialog.open) syncApprovalSubmitState();
    dom.dataProvenance.textContent = state.mode === "live"
      ? "LIVE RELAY SNAPSHOT · AUTHENTICATED APPEND-ONLY EVIDENCE"
      : "DETERMINISTIC SYNTHETIC REPLAY · ZERO MODEL CREDITS";
    dom.connectButton.textContent = state.mode === "live" ? "Live settings" : "Connect live";

    if (state.mode === "live") {
      if (!snapshot.found) setBanner("EMPTY MISSION · No Relay events exist for this mission and namespace yet.");
      else if (!Model.isCompleteEvidenceSnapshot(snapshot)) {
        setBanner("PARTIAL READ · This view is incomplete; do not treat it as a sealed receipt.", "error");
      } else setBanner("LIVE API · Authenticated snapshot. At-action and historical evidence remain separately labeled.", "success");
    } else {
      setBanner("REPLAY MODE · Integrity-checked synthetic fixture. No model credits and no production Remnic data are used.");
    }
  }

  function stopPlayback() {
    state.playing = false;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
    renderControls();
  }

  function frameIndexById(id) {
    return state.replay?.frames.findIndex((frame) => frame.id === id) ?? -1;
  }

  function setFrame(nextIndex, source = "manual") {
    if (!state.replay || nextIndex < 0 || nextIndex >= state.replay.frames.length) return false;
    const nextFrame = state.replay.frames[nextIndex];
    const approvalIndex = frameIndexById("approval");
    if (approvalIndex >= 0 && nextIndex < approvalIndex) {
      state.replayApprovalGranted = false;
    }
    if (nextIndex >= approvalIndex && approvalIndex >= 0 && !state.replayApprovalGranted) {
      state.resumeAfterApproval = source === "playback";
      stopPlayback();
      openApprovalDialog();
      return false;
    }
    state.frameIndex = nextIndex;
    state.snapshot = nextFrame.snapshot;
    render();
    return true;
  }

  function scheduleNextFrame() {
    if (!state.playing || !state.replay) return;
    const frame = state.replay.frames[state.frameIndex];
    state.timer = window.setTimeout(() => {
      if (state.frameIndex >= state.replay.frames.length - 1) {
        stopPlayback();
        showToast("Receipt sealed. One correction changed a cold agent's outcome.");
        return;
      }
      if (setFrame(state.frameIndex + 1, "playback")) scheduleNextFrame();
    }, Math.max(350, (frame.paceMs || 1_200) / state.speed));
  }

  function startPlayback() {
    if (!state.replay || state.mode !== "replay") return;
    if (state.frameIndex >= state.replay.frames.length - 1) {
      state.frameIndex = frameIndexById(state.replay.initialFrameId);
      state.snapshot = state.replay.frames[state.frameIndex].snapshot;
      state.replayApprovalGranted = false;
      render();
    }
    state.playing = true;
    renderControls();
    scheduleNextFrame();
  }

  function togglePlayback() {
    if (state.mode === "live") {
      void refreshLive("manual");
      return;
    }
    if (state.playing) stopPlayback();
    else startPlayback();
  }

  function approvalDraftKey(correctionId, operatorId) {
    return `remnic-relay-approval:${state.missionId}:${state.namespace}:${correctionId}:${operatorId}`;
  }

  function loadApprovalDraft(correctionId, operatorId) {
    const key = approvalDraftKey(correctionId, operatorId);
    const prior = safeSessionGet(key);
    if (!prior) return { key, event: null };
    try {
      const candidate = JSON.parse(prior);
      if (Model.isReusableApprovalEvent(candidate, correctionId, operatorId)) {
        return { key, event: candidate };
      }
    } catch {
      // Invalid or truncated drafts are safe to discard before any write.
    }
    safeSessionRemove(key);
    return { key, event: null };
  }

  function approvalCanSubmit() {
    const confirmed = dom.approvalConfirmInput.value.trim().toUpperCase() === "APPROVE";
    return confirmed
      && approvalReviewMatchesCurrent()
      && (state.mode !== "live" || isLiveApprovalReady());
  }

  function isLiveApprovalReady() {
    return Boolean(
      state.snapshot
      && Model.isValidActorId(state.authenticatedPrincipal)
      && sameLiveContext(state.authenticatedContext, currentLiveContext())
      && Model.isCompleteEvidenceSnapshot(state.snapshot)
    );
  }

  function syncApprovalSubmitState() {
    dom.confirmApprovalButton.disabled = !approvalCanSubmit();
    if (state.approvalReviewKey && !approvalReviewMatchesCurrent()) {
      dom.approvalError.textContent = "The selected correction changed after review. Close this dialog and review it again.";
    }
  }

  function approvalReviewMatchesCurrent() {
    if (!state.snapshot || !state.approvalReviewKey) return false;
    const review = Model.approvalView(state.snapshot);
    return Boolean(review?.complete && review.consentKey === state.approvalReviewKey);
  }

  function renderApprovalReview(review, live) {
    dom.approvalTitle.textContent = review.title;
    dom.approvalLede.textContent = `${review.correctionId} · ${review.rationale}`;
    dom.approvalRetireStatements.textContent = review.retirementStatements.join(" • ");
    dom.approvalReplacementStatement.textContent = review.replacementStatement;
    const badges = review.evidence.map((item) => {
      const badge = document.createElement("span");
      badge.textContent = `✓ ${item.kind}: ${item.label} · ${Model.captureLabel(item.capture)}`;
      return badge;
    });
    if (live) {
      const identityBadge = document.createElement("span");
      identityBadge.textContent = "✓ Server-authenticated human identity";
      badges.push(identityBadge);
    }
    dom.approvalEvidence.replaceChildren(...badges);
  }

  function openApprovalDialog() {
    const review = state.snapshot ? Model.approvalView(state.snapshot) : null;
    if (!review || review.approvedAt) {
      showToast("No correction is currently awaiting human approval.");
      return;
    }
    if (!review.complete) {
      showToast("Approval is disabled because the selected correction cannot be rendered with complete lineage and evidence.");
      return;
    }
    const live = state.mode === "live";
    if (live && !Model.isCompleteEvidenceSnapshot(state.snapshot)) {
      showToast("Live approval requires a complete, untruncated Relay evidence snapshot.");
      return;
    }
    if (live && !Model.isValidActorId(state.authenticatedPrincipal)) {
      showToast("Live approval requires a valid principal resolved by the Relay server.");
      return;
    }
    state.approvalReviewKey = review.consentKey;
    renderApprovalReview(review, live);
    dom.approvalModeLabel.textContent = live ? "AUTHENTICATED LIVE CORRECTION" : "DETERMINISTIC REPLAY GATE";
    dom.liveIdentityFields.hidden = !live;
    dom.operatorIdInput.value = live ? state.authenticatedPrincipal : "";
    const pendingDraft = live
      ? loadApprovalDraft(review.correctionId, state.authenticatedPrincipal).event
      : null;
    dom.operatorLabelInput.readOnly = Boolean(pendingDraft);
    if (pendingDraft) {
      dom.operatorLabelInput.value = pendingDraft.payload.approvedBy.label;
    }
    dom.approvalFootnote.textContent = !live
      ? "Replay mode advances an integrity-checked fixture; it does not claim a live write."
      : pendingDraft
        ? "Retry locked to the exact saved approval event and idempotency key until the live receipt verifies it."
        : "The principal is read-only and server-resolved. One exact approval event and idempotency key are reused across retries.";
    dom.approvalConfirmInput.value = "";
    dom.approvalError.textContent = "";
    syncApprovalSubmitState();
    dom.approvalDialog.showModal();
    requestAnimationFrame(() => dom.approvalConfirmInput.focus());
  }

  async function submitApproval() {
    if (state.mode === "live" && (!state.snapshot || !Model.isCompleteEvidenceSnapshot(state.snapshot))) {
      dom.approvalError.textContent = "Approval is read-only until Relay loads a complete, untruncated evidence snapshot.";
      syncApprovalSubmitState();
      return;
    }
    if (!approvalCanSubmit()) return;
    const review = state.snapshot ? Model.approvalView(state.snapshot) : null;
    if (!review?.complete || review.consentKey !== state.approvalReviewKey) {
      dom.approvalError.textContent = "The selected correction changed after review. Close this dialog and review it again.";
      syncApprovalSubmitState();
      return;
    }
    if (state.mode === "replay") {
      state.replayApprovalGranted = true;
      const shouldResume = state.resumeAfterApproval;
      state.resumeAfterApproval = false;
      dom.approvalDialog.close();
      setFrame(frameIndexById("approval"));
      showToast("Human gate crossed. The stale belief can now retire.");
      if (shouldResume) startPlayback();
      return;
    }

    if (review.approvedAt) {
      dom.approvalError.textContent = "No pending correction is available.";
      return;
    }
    const operatorId = state.authenticatedPrincipal;
    if (!Model.isValidActorId(operatorId)) {
      dom.approvalError.textContent = "The Relay server did not provide a valid authenticated principal.";
      return;
    }
    const context = currentLiveContext();
    const generation = state.connectionGeneration;
    if (!sameLiveContext(state.authenticatedContext, context)) {
      dom.approvalError.textContent = "The authenticated principal no longer belongs to this Relay connection.";
      syncApprovalSubmitState();
      return;
    }
    const operatorLabel = dom.operatorLabelInput.value.trim();
    const draft = loadApprovalDraft(review.correctionId, operatorId);
    const key = draft.key;
    let event = draft.event;
    const reusedPrior = Boolean(event);
    try {
      if (!event) {
        event = Model.createApprovalEvent({
          correctionId: review.correctionId,
          operatorId,
          operatorLabel,
          occurredAt: new Date().toISOString(),
          idempotencyKey: Model.createApprovalId(globalThis.crypto),
        });
      }
      if (!reusedPrior && !safeSessionSet(key, JSON.stringify(event))) {
        throw new Error("Session storage is unavailable; refusing a non-idempotent approval write");
      }
      dom.operatorLabelInput.value = event.payload.approvedBy.label;
      dom.operatorLabelInput.readOnly = true;
      dom.approvalFootnote.textContent = "Approval draft locked to this exact event until the live receipt verifies it.";
    } catch (error) {
      dom.approvalError.textContent = error instanceof Error ? error.message : "Approval could not be prepared.";
      return;
    }

    dom.confirmApprovalButton.disabled = true;
    dom.confirmApprovalButton.textContent = "Writing approval…";
    const requestId = ++state.approvalRequestId;
    const requestMarker = String(requestId);
    dom.approvalDialog.dataset.pendingRequestId = requestMarker;
    const approvalWriteStillCurrent = () => requestId === state.approvalRequestId
      && generation === state.connectionGeneration
      && sameLiveContext(context, currentLiveContext());
    try {
      const response = await fetch(missionApiUrl("events", context), {
        method: "POST",
        headers: liveHeaders(true, context),
        cache: "no-store",
        body: JSON.stringify({ namespace: context.namespace, event }),
      });
      const body = await response.text();
      if (!approvalWriteStillCurrent()) return;
      if (!response.ok) throw relayResponseError(response.status, body);
      const refreshed = await refreshLive("approval");
      if (!approvalWriteStillCurrent()) return;
      if (!refreshed) {
        dom.approvalDialog.close();
        showToast("Approval event recorded; live verification is pending. The next retry will reuse the exact event.");
        return;
      }
      const approved = state.snapshot?.corrections.some((item) => item.correctionId === review.correctionId && item.approvedAt);
      if (!approved) {
        throw new Error("The event was recorded but acceptance is not visible yet. Retry will reuse this exact approval event.");
      }
      safeSessionRemove(key);
      dom.approvalDialog.close();
      showToast("Authenticated human approval recorded in the mission lineage.");
    } catch (error) {
      if (!approvalWriteStillCurrent()) return;
      retainOrClearAuthenticatedPrincipal(error, context);
      if (!Model.isValidActorId(state.authenticatedPrincipal)) dom.operatorIdInput.value = "";
      if (state.mode === "live" && state.snapshot) render();
      dom.approvalError.textContent = error instanceof Error ? error.message : "Approval failed.";
    } finally {
      if (dom.approvalDialog.dataset.pendingRequestId === requestMarker) {
        delete dom.approvalDialog.dataset.pendingRequestId;
        dom.confirmApprovalButton.textContent = "Approve correction →";
        if (approvalWriteStillCurrent()) {
          syncApprovalSubmitState();
        } else {
          dom.confirmApprovalButton.disabled = true;
          if (dom.approvalDialog.open) dom.approvalDialog.close();
        }
      }
    }
  }

  function liveHeaders(json = false, context = currentLiveContext()) {
    const headers = { accept: "application/json", authorization: `Bearer ${context.token}` };
    if (json) headers["content-type"] = "application/json";
    return headers;
  }

  function missionApiUrl(suffix = "", context = currentLiveContext()) {
    const url = new URL(`/engram/v1/relay/missions/${encodeURIComponent(context.missionId)}${suffix ? `/${suffix}` : ""}`, window.location.origin);
    if (!suffix) url.searchParams.set("namespace", context.namespace);
    return url.toString();
  }

  function apiError(status, body) {
    try {
      const parsed = JSON.parse(body);
      return `Relay API ${status}: ${parsed.error || parsed.message || "request failed"}`;
    } catch {
      return `Relay API ${status}: request failed`;
    }
  }

  function relayResponseError(status, body) {
    const error = new Error(apiError(status, body));
    error.relayStatus = status;
    return error;
  }

  function currentLiveContext() {
    return { missionId: state.missionId, namespace: state.namespace, token: state.token };
  }

  function sameLiveContext(left, right) {
    return Boolean(left && right
      && left.missionId === right.missionId
      && left.namespace === right.namespace
      && left.token === right.token);
  }

  function liveReadStillCurrent(context, generation, requestId) {
    return requestId === state.liveReadRequestId
      && generation === state.connectionGeneration
      && sameLiveContext(context, currentLiveContext());
  }

  function bindAuthenticatedPrincipal(principal, context) {
    if (!Model.isValidActorId(principal)) {
      state.authenticatedPrincipal = "";
      state.authenticatedContext = null;
      return;
    }
    state.authenticatedPrincipal = principal;
    state.authenticatedContext = { ...context };
  }

  function retainOrClearAuthenticatedPrincipal(error, context) {
    const retain = Model.canRetainAuthenticatedPrincipal({
      sameConnection: sameLiveContext(state.authenticatedContext, context),
      priorPrincipalValid: Model.isValidActorId(state.authenticatedPrincipal),
      status: Number.isInteger(error?.relayStatus) ? error.relayStatus : null,
      metadataInvalid: error?.relayPrincipalMetadataInvalid === true,
    });
    if (!retain) bindAuthenticatedPrincipal("", context);
  }

  function reportSupersededConnection() {
    dom.connectionError.textContent = "A newer live read superseded this connection attempt. Retry Connect; the current mission and identity were not changed.";
    setBanner("CONNECTION SUPERSEDED · A newer live read won; the current mission and authenticated identity remain unchanged.", "error");
    dom.freshInspectionButton.disabled = state.mode !== "live";
  }

  function invalidateApprovalUiForConnectionChange() {
    state.approvalRequestId += 1;
    state.approvalReviewKey = "";
    delete dom.approvalDialog.dataset.pendingRequestId;
    if (dom.approvalDialog.open) dom.approvalDialog.close();
    dom.confirmApprovalButton.textContent = "Approve correction →";
    dom.confirmApprovalButton.disabled = true;
    dom.approvalConfirmInput.value = "";
    dom.approvalError.textContent = "";
  }

  async function fetchLiveSnapshot(context = currentLiveContext()) {
    if (!context.token) throw new Error("A bearer token is required for live Relay data.");
    const url = new URL(`/engram/v1/relay/missions/${encodeURIComponent(context.missionId)}`, window.location.origin);
    url.searchParams.set("namespace", context.namespace);
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json", authorization: `Bearer ${context.token}` },
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) throw relayResponseError(response.status, body);
    const encodedPrincipal = response.headers.get("x-remnic-authenticated-principal");
    let authenticatedPrincipal = "";
    if (encodedPrincipal) {
      try {
        authenticatedPrincipal = decodeURIComponent(encodedPrincipal);
      } catch {
        const error = new Error("Relay API returned invalid authenticated-principal metadata.");
        error.relayPrincipalMetadataInvalid = true;
        throw error;
      }
    }
    return {
      snapshot: Model.validateSnapshot(JSON.parse(body)),
      authenticatedPrincipal,
    };
  }

  async function refreshLive(reason = "manual") {
    const context = currentLiveContext();
    const generation = state.connectionGeneration;
    const requestId = ++state.liveReadRequestId;
    try {
      const { snapshot, authenticatedPrincipal } = await fetchLiveSnapshot(context);
      if (!liveReadStillCurrent(context, generation, requestId)) return false;
      state.mode = "live";
      state.snapshot = snapshot;
      bindAuthenticatedPrincipal(authenticatedPrincipal, context);
      render();
      if (reason === "manual") showToast("Fresh live mission snapshot loaded.");
      return true;
    } catch (error) {
      if (!liveReadStillCurrent(context, generation, requestId)) return false;
      retainOrClearAuthenticatedPrincipal(error, context);
      if (state.mode === "live" && state.snapshot) render();
      setBanner(`OFFLINE · ${error instanceof Error ? error.message : "Live Relay API is unavailable."}`, "error");
      if (reason === "connection") dom.connectionError.textContent = error instanceof Error ? error.message : "Connection failed.";
      return false;
    } finally {
      if (liveReadStillCurrent(context, generation, requestId)) {
        dom.freshInspectionButton.disabled = state.mode !== "live";
      }
    }
  }

  function evidenceForAgent(agentId) {
    const cards = Model.agentCards(state.snapshot);
    const card = cards.find((item) => item.agentId === agentId);
    if (!card) return { title: "Agent evidence", context: "This agent is not present in the current snapshot.", evidence: [] };
    const ids = new Set((card.evidence || []).map((item) => `${item.kind}:${item.id}:${item.capture}`));
    const all = Model.collectEvidence(state.snapshot);
    return {
      title: `Why did ${card.label} believe this?`,
      context: card.decision?.statement || card.recall?.query || card.output?.summary || "No belief has been observed yet.",
      evidence: all.filter((item) => ids.has(`${item.kind}:${item.id}:${item.capture}`)),
    };
  }

  function evidenceForEvent(eventId) {
    const item = Model.timeline(state.snapshot).find((event) => event.id === eventId);
    if (!item) return { title: "Event evidence", context: "The event is outside this snapshot.", evidence: [] };
    const ids = new Set(item.evidence.map((evidence) => `${evidence.kind}:${evidence.id}:${evidence.capture}`));
    return {
      title: item.verb,
      context: item.summary,
      evidence: Model.collectEvidence(state.snapshot).filter((evidence) => ids.has(`${evidence.kind}:${evidence.id}:${evidence.capture}`)),
    };
  }

  function renderDrawer() {
    const drawer = state.drawer || {
      title: "Mission evidence index",
      context: "Every source below is referenced by the current reducer-produced snapshot.",
      evidence: Model.collectEvidence(state.snapshot),
    };
    dom.drawerTitle.textContent = drawer.title;
    dom.drawerContext.textContent = drawer.context;
    dom.evidenceList.innerHTML = drawer.evidence.length > 0
      ? drawer.evidence.map((item) => `<article class="evidence-item">
          <div class="evidence-item-head"><span class="evidence-kind">${escapeHtml(item.kind)}</span><span class="capture-label">${escapeHtml(Model.captureLabel(item.capture))}</span></div>
          <h3>${escapeHtml(item.label)}</h3>
          <code>${escapeHtml(item.locator || "No external locator")}</code>
          <p class="evidence-contexts">${escapeHtml((item.contexts || []).join(" · "))}</p>
        </article>`).join("")
      : '<p class="evidence-empty">No evidence reference has arrived for this view yet.</p>';
    dom.freshInspectionButton.disabled = state.mode !== "live";
    dom.freshInspectionButton.textContent = state.mode === "live" ? "Run fresh X-ray" : "Live mode required";
    dom.freshInspectionResult.textContent = state.mode === "live" ? "" : "Replay evidence is historical fixture data by design.";
  }

  function openDrawer(drawer = null) {
    if (!state.snapshot) return;
    state.drawer = drawer;
    state.drawerInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    renderDrawer();
    dom.provenanceDrawer.classList.add("open");
    dom.provenanceDrawer.setAttribute("aria-hidden", "false");
    dom.drawerScrim.hidden = false;
    document.querySelector("main").inert = true;
    document.querySelector(".topbar").inert = true;
    document.querySelector(".footer").inert = true;
    requestAnimationFrame(() => dom.closeDrawerButton.focus());
  }

  function closeDrawer() {
    dom.provenanceDrawer.classList.remove("open");
    dom.provenanceDrawer.setAttribute("aria-hidden", "true");
    dom.drawerScrim.hidden = true;
    document.querySelector("main").inert = false;
    document.querySelector(".topbar").inert = false;
    document.querySelector(".footer").inert = false;
    state.drawerInvoker?.focus();
    state.drawerInvoker = null;
  }

  async function runFreshInspection() {
    if (state.mode !== "live") return;
    dom.freshInspectionButton.disabled = true;
    dom.freshInspectionResult.textContent = "Reading live mission now…";
    const context = currentLiveContext();
    const generation = state.connectionGeneration;
    const requestId = ++state.liveReadRequestId;
    try {
      const before = state.snapshot.events.length;
      const { snapshot, authenticatedPrincipal } = await fetchLiveSnapshot(context);
      if (!liveReadStillCurrent(context, generation, requestId)) return;
      state.snapshot = snapshot;
      bindAuthenticatedPrincipal(authenticatedPrincipal, context);
      render();
      renderDrawer();
      dom.freshInspectionResult.textContent = `FRESH INSPECTION · ${new Date().toISOString()} · ${state.snapshot.events.length} events (${state.snapshot.events.length - before >= 0 ? "+" : ""}${state.snapshot.events.length - before}). Not receipt evidence.`;
    } catch (error) {
      if (!liveReadStillCurrent(context, generation, requestId)) return;
      retainOrClearAuthenticatedPrincipal(error, context);
      render();
      renderDrawer();
      dom.freshInspectionResult.textContent = `Fresh inspection failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      if (liveReadStillCurrent(context, generation, requestId)) {
        dom.freshInspectionButton.disabled = false;
      }
    }
  }

  async function connectLive() {
    dom.connectionError.textContent = "";
    const requestId = ++state.connectionRequestId;
    const missionId = dom.missionInput.value.trim();
    const namespace = dom.namespaceInput.value.trim();
    const token = dom.tokenInput.value || state.token;
    if (!missionId || !namespace || !token) {
      dom.connectionError.textContent = "Mission, namespace, and bearer token are required.";
      return;
    }
    const context = { missionId, namespace, token };
    const liveReadRequestId = ++state.liveReadRequestId;
    let liveResult;
    try {
      liveResult = await fetchLiveSnapshot(context);
    } catch (error) {
      if (requestId !== state.connectionRequestId) return;
      if (liveReadRequestId !== state.liveReadRequestId) {
        reportSupersededConnection();
        return;
      }
      dom.connectionError.textContent = error instanceof Error ? error.message : "Connection failed.";
      setBanner("CONNECTION FAILED · The current mission and authenticated identity remain unchanged.", "error");
      dom.freshInspectionButton.disabled = state.mode !== "live";
      return;
    }
    if (requestId !== state.connectionRequestId) return;
    if (liveReadRequestId !== state.liveReadRequestId) {
      reportSupersededConnection();
      return;
    }
    stopPlayback();
    invalidateApprovalUiForConnectionChange();
    state.connectionGeneration += 1;
    state.missionId = context.missionId;
    state.namespace = context.namespace;
    state.token = context.token;
    state.mode = "live";
    state.snapshot = liveResult.snapshot;
    bindAuthenticatedPrincipal(liveResult.authenticatedPrincipal, context);
    dom.freshInspectionButton.disabled = false;
    const tokenRetained = safeSessionSet(TOKEN_KEY, token);
    render();
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "live");
    url.searchParams.set("mission", state.missionId);
    url.searchParams.set("namespace", state.namespace);
    history.replaceState(null, "", url);
    dom.connectionDialog.close();
    showToast(tokenRetained
      ? "Mission Control is reading the authenticated live Relay API."
      : "Connected live; session storage is unavailable, so this tab will not retain the credential.");
  }

  function openConnectionDialog() {
    dom.missionInput.value = state.missionId;
    dom.namespaceInput.value = state.namespace;
    dom.tokenInput.value = state.token;
    dom.connectionError.textContent = "";
    dom.connectionDialog.showModal();
  }

  function bindEvents() {
    dom.playButton.addEventListener("click", togglePlayback);
    dom.previousButton.addEventListener("click", () => { stopPlayback(); setFrame(state.frameIndex - 1); });
    dom.nextButton.addEventListener("click", () => { stopPlayback(); setFrame(state.frameIndex + 1); });
    dom.restartButton.addEventListener("click", () => {
      stopPlayback();
      state.replayApprovalGranted = false;
      setFrame(frameIndexById(state.replay.initialFrameId));
      showToast("Replay reset to the moment the agents disagree.");
    });
    dom.speedSelect.addEventListener("change", () => {
      const speed = Number(dom.speedSelect.value);
      state.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
      if (state.playing) { if (state.timer) clearTimeout(state.timer); scheduleNextFrame(); }
    });
    dom.approveButton.addEventListener("click", openApprovalDialog);
    dom.approvalConfirmInput.addEventListener("input", syncApprovalSubmitState);
    dom.approvalForm.addEventListener("submit", (event) => { event.preventDefault(); void submitApproval(); });
    dom.approvalDialog.addEventListener("close", () => {
      state.approvalReviewKey = "";
      if (!state.replayApprovalGranted) state.resumeAfterApproval = false;
    });
    dom.connectionForm.addEventListener("submit", (event) => { event.preventDefault(); void connectLive(); });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog)?.close());
    });
    dom.connectButton.addEventListener("click", openConnectionDialog);
    dom.evidenceIndexButton.addEventListener("click", () => openDrawer());
    dom.closeDrawerButton.addEventListener("click", closeDrawer);
    dom.drawerScrim.addEventListener("click", closeDrawer);
    dom.freshInspectionButton.addEventListener("click", () => void runFreshInspection());
    dom.agentGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-agent-id]");
      if (button?.dataset.agentId) openDrawer(evidenceForAgent(button.dataset.agentId));
    });
    dom.lineage.addEventListener("click", (event) => {
      const button = event.target.closest("[data-agent-id]");
      if (button?.dataset.agentId) openDrawer(evidenceForAgent(button.dataset.agentId));
    });
    dom.eventRail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-event-id]");
      if (button?.dataset.eventId) openDrawer(evidenceForEvent(button.dataset.eventId));
    });
    document.addEventListener("keydown", (event) => {
      const tag = event.target?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "select" || tag === "textarea" || event.target?.isContentEditable;
      if (dom.provenanceDrawer.classList.contains("open")) {
        if (event.key === "Escape") { closeDrawer(); return; }
        if (event.key === "Tab") {
          const focusable = [...dom.provenanceDrawer.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
            .filter((item) => item.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first && last && event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (first && last && !event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (isTyping || dom.approvalDialog.open || dom.connectionDialog.open) return;
      if (event.key === " ") { event.preventDefault(); togglePlayback(); }
      else if (event.key === "ArrowLeft" && state.mode === "replay") { event.preventDefault(); stopPlayback(); setFrame(state.frameIndex - 1); }
      else if (event.key === "ArrowRight" && state.mode === "replay") { event.preventDefault(); stopPlayback(); setFrame(state.frameIndex + 1); }
      else if (event.key.toLowerCase() === "e") { event.preventDefault(); openDrawer(); }
    });
  }

  async function loadReplay() {
    const response = await fetch("./replay.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Replay fixture failed to load (${response.status})`);
    state.replay = Model.validateReplay(await response.json());
  }

  async function initialize() {
    bindEvents();
    const prefillToken = window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__;
    if (typeof prefillToken === "string") {
      safeSessionSet(TOKEN_KEY, prefillToken);
    }
    state.token = safeSessionGet(TOKEN_KEY);
    const params = new URLSearchParams(window.location.search);
    state.missionId = params.get("mission") || state.missionId;
    state.namespace = params.get("namespace") || state.namespace;

    try {
      await loadReplay();
      const requestedLive = params.get("mode") === "live";
      if (requestedLive && state.token) {
        const connected = await refreshLive("connection");
        if (!connected) {
          state.mode = "replay";
          state.frameIndex = frameIndexById(state.replay.initialFrameId);
          state.snapshot = state.replay.frames[state.frameIndex].snapshot;
          render();
          setBanner("OFFLINE FALLBACK · Live Relay was unavailable, so Mission Control loaded the labeled synthetic replay.", "error");
        }
      } else {
        state.mode = "replay";
        state.frameIndex = frameIndexById(state.replay.initialFrameId);
        state.snapshot = state.replay.frames[state.frameIndex].snapshot;
        render();
        if (requestedLive && !state.token) {
          openConnectionDialog();
          setBanner("LIVE TOKEN REQUIRED · Replay remains visible until an authenticated connection succeeds.");
        }
      }
    } catch (error) {
      setBanner(`MISSION CONTROL ERROR · ${error instanceof Error ? error.message : "Unable to load Relay data."}`, "error");
      document.querySelector("main").setAttribute("aria-busy", "false");
    } finally {
      dom.loadingScreen.classList.add("hidden");
    }
  }

  void initialize();
})();
