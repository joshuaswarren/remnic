(function startWhatHelpsMe() {
  const bootstrapHash = window.__REMNIC_WHAT_HELPS_ME_FRAGMENT__;
  const initialHash = typeof bootstrapHash === "string" ? bootstrapHash : window.location.hash;
  const hasSecretFragment = new URLSearchParams(initialHash.slice(1)).has("secret");
  if (hasSecretFragment) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const model = window.WhatHelpsMeModel;
  if (!model) throw new Error("What Helps Me model did not load.");

  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const replayMode = params.get("mode") === "replay";
  const grantId = params.get("grant") ?? "";
  let initialHelperSecret = model.parseSecret(initialHash);
  const replayStore = replayMode ? model.createReplayStore() : null;
  const replayChannel =
    replayMode && "BroadcastChannel" in window ? new BroadcastChannel("remnic-what-helps-me-replay") : null;
  const HELPER_REVALIDATION_MS = 30_000;
  const HELPER_REVALIDATION_MAX_MS = 5 * 60_000;
  const HELPER_READ_TIMEOUT_MS = 10_000;
  const HELPER_QUESTION_TIMEOUT_MS = 15 * 60_000;
  const OWNER_READ_TIMEOUT_MS = 30_000;
  const OWNER_WRITE_TIMEOUT_MS = 60_000;
  const OWNER_MODEL_WRITE_TIMEOUT_MS = 15 * 60_000;
  const OWNER_RECONCILIATION_ATTEMPTS = 4;
  const OWNER_RECONCILIATION_DELAY_MS = 250;
  const MAX_VISIBLE_GRANTS = 100;
  const MAX_SHARED_CARDS = 8;
  const PAGE_HIDDEN_ABORT = new Error("The page was hidden.");
  const HELPER_READ_TIMEOUT_ABORT = Object.assign(new Error("The support passport check took too long."), {
    code: "request_timeout",
  });
  const SCROLL_BEHAVIOR = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const TERMINAL_HELPER_ERROR_CODES = new Set([
    "grant_expired",
    "grant_gone",
    "grant_not_found",
    "grant_stale",
    "missing_link",
    "session_ended",
  ]);
  const REPLAY_SYNC_TIMEOUT_MS = 2_000;

  const state = {
    token: "",
    cards: [],
    grants: [],
    selectedNotes: [],
    guide: null,
    helperSecret: initialHelperSecret,
    helperGrantId: grantId,
    helperServerOffsetMs: null,
    helperExpiryTimer: null,
    helperLoadController: null,
    helperQuestionController: null,
    helperRevalidationController: null,
    helperRevalidationTimer: null,
    helperRevalidationDelayMs: HELPER_REVALIDATION_MS,
    helperViewGeneration: 0,
    helperLifecyclePaused: false,
    ownerServerOffsetMs: null,
    pendingCardMutationIds: new Set(),
    pendingGrantRevocationIds: new Set(),
    cardSavePending: false,
    notePreviewPending: false,
    draftGenerationPending: false,
    shareCreationPending: false,
    shareCreationCardIds: null,
    displayedGrant: null,
    displayedGrantTimer: null,
    ownerGrantExpiryTimer: null,
    ownerLifecyclePaused: false,
    ownerRequestControllers: new Set(),
    ownerLoadGeneration: 0,
    ownerSessionGeneration: 0,
    announcementTimer: null,
    toastTimer: null,
  };
  initialHelperSecret = "";

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    node.replaceChildren();
  }

  function setError(id, message = "") {
    if (message === null) return;
    if (message && (state.ownerLifecyclePaused || state.helperLifecyclePaused)) return;
    byId(id).textContent = message;
  }

  function ownerNowMs() {
    return Date.now() + (state.ownerServerOffsetMs ?? 0);
  }

  function ownerSessionIsCurrent(generation) {
    return !state.ownerLifecyclePaused && generation === state.ownerSessionGeneration;
  }

  function clearDisplayedShareLink() {
    window.clearTimeout(state.displayedGrantTimer);
    state.displayedGrantTimer = null;
    state.displayedGrant = null;
    byId("newLinkPanel").hidden = true;
    byId("shareLinkInput").value = "";
    byId("openLinkButton").removeAttribute("href");
  }

  function scheduleDisplayedShareLinkExpiry() {
    window.clearTimeout(state.displayedGrantTimer);
    state.displayedGrantTimer = null;
    if (!state.displayedGrant) return;
    const remainingMs = Date.parse(state.displayedGrant.expiresAt) - ownerNowMs();
    if (remainingMs <= 0) {
      clearDisplayedShareLink();
      return;
    }
    state.displayedGrantTimer = window.setTimeout(clearDisplayedShareLink, remainingMs);
  }

  function reconcileDisplayedShareLink() {
    const displayed = state.displayedGrant;
    if (!displayed) return;
    const grant = state.grants.find((candidate) => candidate.grantId === displayed.grantId);
    const cardsStillCurrent = displayed.cards.every((selected) =>
      state.cards.some(
        (card) => card.cardId === selected.cardId && card.revision === selected.revision && card.status === "active"
      )
    );
    if (!grant || grant.status !== "active" || Date.parse(grant.expiresAt) <= ownerNowMs() || !cardsStillCurrent) {
      clearDisplayedShareLink();
      return;
    }
    scheduleDisplayedShareLinkExpiry();
  }

  function clearDisplayedShareLinkForCard(cardId) {
    if (state.displayedGrant?.cards.some((card) => card.cardId === cardId)) clearDisplayedShareLink();
  }

  function announce(message) {
    window.clearTimeout(state.announcementTimer);
    byId("announcer").textContent = "";
    state.announcementTimer = window.setTimeout(() => {
      state.announcementTimer = null;
      byId("announcer").textContent = message;
    }, 10);
  }

  function toast(message) {
    const node = byId("toast");
    window.clearTimeout(state.toastTimer);
    node.textContent = message;
    node.classList.add("visible");
    state.toastTimer = window.setTimeout(() => node.classList.remove("visible"), 3_600);
  }

  function errorMessage(error, fallback) {
    if (error === PAGE_HIDDEN_ABORT) return null;
    if (error instanceof Error && error.message.trim()) return error.message;
    return fallback;
  }

  async function withBusy(button, label, run) {
    const prior = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await run();
    } finally {
      button.disabled = false;
      button.textContent = prior;
    }
  }

  async function fetchJson(path, options = {}) {
    if (options.owner && state.ownerLifecyclePaused) throw PAGE_HIDDEN_ABORT;
    const method = options.method ?? "GET";
    const timeoutMs =
      options.timeoutMs ??
      (options.owner ? (method === "GET" ? OWNER_READ_TIMEOUT_MS : OWNER_WRITE_TIMEOUT_MS) : undefined);
    const controller = Number.isFinite(timeoutMs) ? new AbortController() : null;
    let timedOut = false;
    let timeout;
    let removeCallerAbort = () => {};
    if (controller && options.signal) {
      const abortFromCaller = () => controller.abort(options.signal.reason);
      if (options.signal.aborted) abortFromCaller();
      else options.signal.addEventListener("abort", abortFromCaller, { once: true });
      removeCallerAbort = () => options.signal.removeEventListener("abort", abortFromCaller);
    }
    if (controller) {
      timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("The request took too long."));
      }, timeoutMs);
    }
    if (options.owner && controller) state.ownerRequestControllers.add(controller);
    const headers = new Headers(options.headers ?? {});
    headers.set("accept", "application/json");
    if (options.owner) headers.set("authorization", `Bearer ${state.token}`);
    if (options.secret) headers.set("authorization", `SupportPassport ${options.secret}`);
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    try {
      const response = await fetch(path, {
        method,
        headers,
        body,
        cache: "no-store",
        signal: controller?.signal ?? options.signal,
      });
      if ((controller?.signal ?? options.signal)?.reason === PAGE_HIDDEN_ABORT) throw PAGE_HIDDEN_ABORT;
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`The server returned invalid JSON with HTTP ${response.status}.`);
      }
      if (!response.ok) {
        const error = new Error(
          typeof payload.error === "string" ? payload.error : `The server returned HTTP ${response.status}.`
        );
        error.code = typeof payload.code === "string" ? payload.code : "request_failed";
        error.status = response.status;
        throw error;
      }
      if (options.owner && state.ownerLifecyclePaused) throw PAGE_HIDDEN_ABORT;
      const serverNowMs = Date.parse(response.headers.get("date") ?? "");
      if (options.owner && Number.isFinite(serverNowMs)) {
        state.ownerServerOffsetMs = serverNowMs - Date.now();
      }
      if (!options.captureServerTime) return payload;
      return {
        payload,
        serverOffsetMs: Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : null,
      };
    } catch (error) {
      if (
        (controller?.signal ?? options.signal)?.reason === PAGE_HIDDEN_ABORT ||
        (options.owner && state.ownerLifecyclePaused) ||
        (options.secret && state.helperLifecyclePaused)
      ) {
        throw PAGE_HIDDEN_ABORT;
      }
      if (!timedOut) throw error;
      const timeoutError = new Error(options.timeoutMessage ?? "The owner request took too long. Try again.");
      timeoutError.code = "request_timeout";
      throw timeoutError;
    } finally {
      if (timeout) window.clearTimeout(timeout);
      if (options.owner && controller) state.ownerRequestControllers.delete(controller);
      removeCallerAbort();
    }
  }

  const liveApi = {
    listCards: () => fetchJson("/engram/v1/support-passport/cards", { owner: true }),
    listGrants: () => fetchJson("/engram/v1/support-passport/grants", { owner: true }),
    fetchMemory: (memoryId) =>
      fetchJson(`/engram/v1/support-passport/memories/${encodeURIComponent(memoryId)}`, { owner: true }),
    createManualDraft: (input) =>
      fetchJson("/engram/v1/support-passport/drafts", { owner: true, method: "POST", body: input }),
    generateDrafts: (input) =>
      fetchJson("/engram/v1/support-passport/drafts/generate", {
        owner: true,
        method: "POST",
        body: input,
        timeoutMs: OWNER_MODEL_WRITE_TIMEOUT_MS,
        timeoutMessage: "Drafting timed out.",
      }),
    replaceCard: (cardId, input) =>
      fetchJson(`/engram/v1/support-passport/cards/${encodeURIComponent(cardId)}`, {
        owner: true,
        method: "PUT",
        body: input,
      }),
    mutateCard: (cardId, input, action) =>
      fetchJson(`/engram/v1/support-passport/cards/${encodeURIComponent(cardId)}/${action}`, {
        owner: true,
        method: "POST",
        body: input,
      }),
    createGrant: (input) =>
      fetchJson("/engram/v1/support-passport/grants", { owner: true, method: "POST", body: input }),
    revokeGrant: (id, input) =>
      fetchJson(`/engram/v1/support-passport/grants/${encodeURIComponent(id)}/revoke`, {
        owner: true,
        method: "POST",
        body: input,
      }),
    readGrant: (id, helperSecret, signal) =>
      fetchJson(`/engram/v1/support-passport/public/grants/${encodeURIComponent(id)}`, {
        secret: helperSecret,
        signal,
        captureServerTime: true,
      }),
    askGrant: (id, helperSecret, question, signal) =>
      fetchJson(`/engram/v1/support-passport/public/grants/${encodeURIComponent(id)}/ask`, {
        secret: helperSecret,
        method: "POST",
        body: { question },
        signal,
      }),
  };

  const replayApi = replayStore && {
    ...replayStore,
    async fetchMemory(memoryId) {
      const note = replayStore.notes.find((candidate) => candidate.memoryId === memoryId);
      if (!note) return { found: false };
      return { found: true, memory: { id: note.memoryId, content: note.content, revision: note.revision } };
    },
  };
  const api = replayMode ? replayApi : liveApi;

  function showOwner() {
    byId("connectPanel").hidden = true;
    byId("helperView")?.remove();
    byId("lockedView")?.remove();
    byId("ownerView").hidden = false;
    byId("viewMarkerText").textContent = replayMode ? "Owner replay" : "Owner view";
  }

  function requestReplaySharedGuide() {
    if (!replayChannel) return Promise.reject(new Error("The replay share state is unavailable."));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timeout;
      const finish = (callback, value) => {
        window.clearTimeout(timeout);
        replayChannel.removeEventListener("message", receive);
        callback(value);
      };
      const receive = (event) => {
        if (event.data?.type === "grant-state" && event.data.requestId === requestId) {
          if (event.data.snapshot) finish(resolve, event.data.snapshot);
          else finish(reject, new Error("The replay share state is unavailable."));
        }
      };
      replayChannel.addEventListener("message", receive);
      timeout = window.setTimeout(
        () => finish(reject, new Error("The replay share state is unavailable.")),
        REPLAY_SYNC_TIMEOUT_MS
      );
      try {
        replayChannel.postMessage({
          type: "grant-request",
          requestId,
          grantId: state.helperGrantId,
          secret: state.helperSecret,
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function bindReplayOwnerBridge() {
    if (!replayChannel || !replayStore) return;
    replayChannel.addEventListener("message", (event) => {
      const request = event.data;
      if (
        request?.type !== "grant-request" ||
        typeof request.requestId !== "string" ||
        typeof request.grantId !== "string" ||
        typeof request.secret !== "string"
      ) {
        return;
      }
      const snapshot = replayStore.exportSharedGuide(request.grantId, request.secret);
      if (snapshot) replayChannel.postMessage({ type: "grant-state", requestId: request.requestId, snapshot });
    });
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) replayChannel.close();
    });
  }

  function renderSelectedNotes() {
    const list = byId("noteList");
    clear(list);
    byId("notesEmpty").hidden = state.selectedNotes.length > 0;
    byId("noteCount").textContent = `${state.selectedNotes.length} selected`;
    for (const note of state.selectedNotes) {
      const item = element("li", "note-item");
      const copy = element("div");
      copy.append(element("code", "", note.memoryId), element("p", "", note.content));
      const remove = element("button", "button button-quiet", "Remove");
      remove.type = "button";
      remove.disabled = state.draftGenerationPending;
      remove.setAttribute("aria-label", `Remove selected note ${note.memoryId}`);
      remove.addEventListener("click", () => {
        state.selectedNotes = state.selectedNotes.filter((candidate) => candidate.memoryId !== note.memoryId);
        byId("consentInput").checked = false;
        renderSelectedNotes();
        announce("Selected note removed. Consent cleared.");
      });
      item.append(copy, remove);
      list.append(item);
    }
  }

  function statusLabel(card) {
    return card.status === "active" ? "Approved" : "Draft";
  }

  function cardButton(label, className, handler) {
    const button = element("button", `button ${className}`, label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  async function mutateCard(card, action, button) {
    if (state.shareCreationPending && state.shareCreationCardIds?.has(card.cardId)) return;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    setError("generateError");
    const verbs = { approve: "Approving…", reject: "Rejecting…", withdraw: "Stopping…" };
    const priorLabel = button.textContent;
    state.pendingCardMutationIds.add(card.cardId);
    for (const actionButton of button.closest(".card-actions")?.querySelectorAll("button") ?? []) {
      actionButton.disabled = true;
    }
    button.textContent = verbs[action];
    updateShareCardChoices();
    try {
      let ownerStateFresh = false;
      let invalidatedCardIds = [];
      try {
        const result = await api.mutateCard(
          card.cardId,
          {
            expectedRevision: card.revision,
            reasonCode:
              action === "approve"
                ? "owner-approved-ui"
                : action === "reject"
                  ? "owner-rejected-ui"
                  : "owner-withdrew-ui",
          },
          action
        );
        if (replayMode && Array.isArray(result?.invalidatedCardIds)) {
          invalidatedCardIds = result.invalidatedCardIds.filter((cardId) => typeof cardId === "string");
        }
      } catch (error) {
        if (error?.code !== "request_timeout") {
          setError("generateError", errorMessage(error, "The support card did not change."));
          return;
        }
        const reconciled = await reconcileOwnerState(() => {
          const current = state.cards.find((candidate) => candidate.cardId === card.cardId);
          if (action === "approve") {
            return current?.status === "active" && current.revision !== card.revision ? current : null;
          }
          return current ? null : card;
        });
        if (reconciled.cancelled) return;
        if (!reconciled.matched) {
          setError(
            "generateError",
            reconciled.refreshed
              ? "The request stopped without a confirmed change. Review the current guide before trying again."
              : "The request stopped without a confirmed change. Refresh the guide before trying again."
          );
          return;
        }
        ownerStateFresh = true;
      }
      if (invalidatedCardIds.length > 0) {
        replayChannel?.postMessage({ type: "cards-stale", cardIds: invalidatedCardIds });
      }
      const message =
        action === "approve"
          ? `Approved ${card.title}. It can now be shared.`
          : action === "reject"
            ? `Rejected ${card.title}. It stays private.`
            : `Withdrew ${card.title}. Existing links will lock.`;
      if (action === "withdraw") clearDisplayedShareLinkForCard(card.cardId);
      toast(message);
      announce(message);
      try {
        if (!ownerStateFresh) await loadOwnerState();
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return;
        const warning = `${message} The card list did not refresh. Refresh the guide before another change.`;
        setError("generateError", warning);
        announce(warning);
      }
    } finally {
      if (ownerSessionIsCurrent(ownerSessionGeneration)) {
        state.pendingCardMutationIds.delete(card.cardId);
        button.disabled = false;
        button.textContent = priorLabel;
        renderCards();
        updateShareCardChoices();
      }
    }
  }

  function renderCards() {
    const list = byId("cardList");
    clear(list);
    byId("cardsEmpty").hidden = state.cards.length > 0;
    const drafts = state.cards.filter((card) => card.status === "pending_review").length;
    const approved = state.cards.filter((card) => card.status === "active").length;
    byId("draftCount").textContent = String(drafts);
    byId("approvedCount").textContent = String(approved);

    for (const card of state.cards) {
      const article = element("article", "support-card");
      article.dataset.cardId = card.cardId;
      article.dataset.category = card.category;
      const top = element("div", "card-topline");
      const status = element(
        "span",
        `status-pill ${card.status === "active" ? "approved" : "draft"}`,
        statusLabel(card)
      );
      const category = element("span", "category-pill", model.CATEGORY_LABELS[card.category]);
      top.append(status, category);
      const title = element("h3", "", card.title);
      const statement = element("blockquote", "", card.statement);
      const dates = element("div", "card-dates");
      dates.append(
        element("span", "", `Updated ${model.formatDate(card.updatedAt)}`),
        element("span", "", `Review by ${model.formatDate(card.reviewBy)}`)
      );
      const actions = element("div", "card-actions");
      actions.append(cardButton("Edit", "button-quiet", () => openCardDialog(card)));
      if (card.status === "pending_review") {
        const approve = cardButton("Approve", "button-primary", (event) =>
          mutateCard(card, "approve", event.currentTarget)
        );
        const reject = cardButton("Reject", "button-danger", (event) =>
          mutateCard(card, "reject", event.currentTarget)
        );
        actions.append(approve, reject);
      } else {
        actions.append(
          cardButton("Withdraw", "button-danger", (event) => mutateCard(card, "withdraw", event.currentTarget))
        );
      }
      if (
        state.pendingCardMutationIds.has(card.cardId) ||
        (state.shareCreationPending && state.shareCreationCardIds?.has(card.cardId))
      ) {
        for (const button of actions.querySelectorAll("button")) button.disabled = true;
      }
      article.append(top, title, statement, dates, actions);
      list.append(article);
    }
  }

  function renderShareCards() {
    const list = byId("shareCardList");
    clear(list);
    const approved = state.cards.filter((card) => card.status === "active");
    byId("shareCardsEmpty").hidden = approved.length > 0;
    for (const card of approved) {
      const label = element("label", "card-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "shareCard";
      input.value = card.cardId;
      input.dataset.revision = card.revision;
      input.checked = state.shareCreationCardIds?.has(card.cardId) ?? false;
      input.addEventListener("change", updateShareCardChoices);
      const copy = element("span");
      copy.append(element("strong", "", card.title), element("small", "", card.statement));
      label.append(input, copy);
      list.append(label);
    }
    updateShareCardChoices();
  }

  function updateShareCardChoices() {
    const choices = [...document.querySelectorAll('input[name="shareCard"]')];
    const selectedMutationPending = choices.some(
      (input) => input.checked && state.pendingCardMutationIds.has(input.value)
    );
    const submit = byId("shareForm").querySelector('button[type="submit"]');
    submit.disabled = state.shareCreationPending || selectedMutationPending;
    if (state.shareCreationPending) {
      for (const input of choices) input.disabled = true;
      return;
    }
    const selectedCount = choices.filter((input) => input.checked).length;
    for (const input of choices) input.disabled = !input.checked && selectedCount >= MAX_SHARED_CARDS;
  }

  function setShareCreationPending(pending, selectedInputs = []) {
    state.shareCreationPending = pending;
    state.shareCreationCardIds = pending ? new Set(selectedInputs.map((input) => input.value)) : null;
    for (const input of document.querySelectorAll('input[name="duration"], #customTimeInput')) {
      input.disabled = pending;
    }
    renderCards();
    updateShareCardChoices();
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function reconcileOwnerState(match) {
    const ownerSessionGeneration = state.ownerSessionGeneration;
    if (!ownerSessionIsCurrent(ownerSessionGeneration)) return { matched: false, refreshed: false, cancelled: true };
    let refreshed = false;
    for (let attempt = 0; attempt < OWNER_RECONCILIATION_ATTEMPTS; attempt += 1) {
      if (!ownerSessionIsCurrent(ownerSessionGeneration)) return { matched: false, refreshed, cancelled: true };
      try {
        await loadOwnerState();
        if (!ownerSessionIsCurrent(ownerSessionGeneration)) return { matched: false, refreshed, cancelled: true };
        refreshed = true;
        const value = match();
        if (value) return { matched: true, value };
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return { matched: false, refreshed, cancelled: true };
      }
      if (attempt + 1 < OWNER_RECONCILIATION_ATTEMPTS) {
        await delay(OWNER_RECONCILIATION_DELAY_MS);
      }
    }
    return { matched: false, refreshed };
  }

  function renderGrants() {
    window.clearTimeout(state.ownerGrantExpiryTimer);
    state.ownerGrantExpiryTimer = null;
    const list = byId("grantList");
    clear(list);
    byId("grantsEmpty").hidden = state.grants.length > 0;
    for (const grant of state.grants) {
      const grantStatus =
        grant.status === "active" && Date.parse(grant.expiresAt) <= ownerNowMs() ? "expired" : grant.status;
      const article = element("article", "grant-card");
      article.dataset.grantId = grant.grantId;
      const stateText =
        grantStatus === "active" ? "Live share" : grantStatus === "revoked" ? "Sharing stopped" : "Share time ended";
      article.append(
        element("p", "", stateText),
        element(
          "div",
          "grant-meta",
          `${grant.cards.length} card${grant.cards.length === 1 ? "" : "s"} · Ends ${model.formatDate(grant.expiresAt)}`
        )
      );
      if (grantStatus === "active") {
        const stop = cardButton("Stop sharing", "button-danger", async (event) => {
          const ownerSessionGeneration = state.ownerSessionGeneration;
          const button = event.currentTarget;
          const priorLabel = button.textContent;
          let ownerStateFresh = false;
          state.pendingGrantRevocationIds.add(grant.grantId);
          button.disabled = true;
          button.textContent = "Stopping sharing…";
          try {
            try {
              await api.revokeGrant(grant.grantId, { expectedVersion: grant.stateVersion });
            } catch (error) {
              if (error?.code !== "request_timeout") {
                setError("shareError", errorMessage(error, "The share link did not stop."));
                return;
              }
              const reconciled = await reconcileOwnerState(() => {
                const current = state.grants.find((candidate) => candidate.grantId === grant.grantId);
                return !current || current.status !== "active" ? grant : null;
              });
              if (reconciled.cancelled) return;
              if (!reconciled.matched) {
                setError(
                  "shareError",
                  "The server did not confirm that sharing stopped. Refresh the guide and check this link."
                );
                return;
              }
              ownerStateFresh = true;
            }
            if (state.displayedGrant?.grantId === grant.grantId) clearDisplayedShareLink();
            replayChannel?.postMessage({ type: "grant-revoked", grantId: grant.grantId });
            const message = "Sharing stopped. The helper link is now locked.";
            toast(message);
            announce(message);
            try {
              if (!ownerStateFresh) await loadOwnerState();
            } catch (error) {
              if (error === PAGE_HIDDEN_ABORT) return;
              const warning = `${message} The share list did not refresh. Refresh the guide before another change.`;
              setError("shareError", warning);
              announce(warning);
            }
          } finally {
            if (ownerSessionIsCurrent(ownerSessionGeneration)) {
              state.pendingGrantRevocationIds.delete(grant.grantId);
              button.disabled = false;
              button.textContent = priorLabel;
              renderGrants();
            }
          }
        });
        stop.disabled = state.pendingGrantRevocationIds.has(grant.grantId);
        article.append(stop);
      }
      list.append(article);
    }
    const nextExpiry = state.grants
      .filter((grant) => grant.status === "active")
      .map((grant) => Date.parse(grant.expiresAt) - ownerNowMs())
      .filter((remainingMs) => remainingMs > 0)
      .sort((left, right) => left - right)[0];
    if (Number.isFinite(nextExpiry)) {
      state.ownerGrantExpiryTimer = window.setTimeout(() => {
        reconcileDisplayedShareLink();
        renderGrants();
      }, nextExpiry);
    }
  }

  async function loadOwnerState() {
    const generation = ++state.ownerLoadGeneration;
    const [cardPayload, grantPayload] = await Promise.all([api.listCards(), api.listGrants()]);
    const cards = model.parseCardList(cardPayload);
    const grants = model.parseGrantList(grantPayload).slice(0, MAX_VISIBLE_GRANTS);
    if (generation !== state.ownerLoadGeneration || state.ownerLifecyclePaused) return false;
    state.cards = cards;
    state.grants = grants;
    reconcileDisplayedShareLink();
    renderCards();
    renderShareCards();
    renderGrants();
    return true;
  }

  function toLocalInputValue(date) {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function openCardDialog(card = null) {
    if (state.cardSavePending) return;
    byId("cardDialogTitle").textContent = card ? "Edit this support card" : "Write a support card";
    byId("cardSaveButton").textContent = "Save draft";
    byId("cardIdInput").value = card?.cardId ?? "";
    byId("cardRevisionInput").value = card?.revision ?? "";
    byId("cardTitleInput").value = card?.title ?? "";
    byId("cardStatementInput").value = card?.statement ?? "";
    byId("cardCategoryInput").value = card?.category ?? "communication";
    byId("cardReviewInput").value = toLocalInputValue(
      card ? new Date(card.reviewBy) : new Date(Date.now() + 180 * 24 * 60 * 60_000)
    );
    setError("cardError");
    byId("cardDialog").showModal();
    byId("cardTitleInput").focus();
  }

  function closeCardDialog() {
    if (state.cardSavePending) return;
    byId("cardDialog").close();
  }

  function setCardSavePending(pending) {
    state.cardSavePending = pending;
    byId("cardForm").setAttribute("aria-busy", String(pending));
    for (const control of byId("cardForm").querySelectorAll("input, textarea, select, button")) {
      control.disabled = pending;
    }
    byId("newCardButton").disabled = pending;
  }

  async function saveCard(event) {
    event.preventDefault();
    if (state.cardSavePending) return;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    setError("cardError");
    const cardId = byId("cardIdInput").value;
    const expectedRevision = byId("cardRevisionInput").value;
    const reviewValue = byId("cardReviewInput").value;
    const reviewDate = new Date(reviewValue);
    const existingCard = state.cards.find((card) => card.cardId === cardId);
    const keepsExistingReminder = existingCard && reviewValue === toLocalInputValue(new Date(existingCard.reviewBy));
    if (!Number.isFinite(reviewDate.getTime()) || (reviewDate.getTime() <= Date.now() && !keepsExistingReminder)) {
      setError("cardError", "Choose a future review reminder.");
      return;
    }
    const input = {
      title: byId("cardTitleInput").value.trim(),
      statement: byId("cardStatementInput").value.trim(),
      category: byId("cardCategoryInput").value,
      reviewBy: keepsExistingReminder ? existingCard.reviewBy : reviewDate.toISOString(),
      ...(cardId ? { expectedRevision } : {}),
    };
    const button = byId("cardSaveButton");
    const priorLabel = button.textContent;
    setCardSavePending(true);
    button.textContent = "Saving draft…";
    try {
      try {
        await (cardId ? api.replaceCard(cardId, input) : api.createManualDraft(input));
      } catch (error) {
        if (error?.code !== "request_timeout") {
          setError("cardError", errorMessage(error, "The draft did not save."));
          return;
        }
        const reconciled = await reconcileOwnerState(() => null);
        if (reconciled.cancelled) return;
        let message;
        if (cardId) {
          message = reconciled.refreshed
            ? "The edit timed out. Review the current guide before trying again."
            : "The server did not confirm the edit. Refresh the guide before trying again.";
        } else {
          message = reconciled.refreshed
            ? "The request timed out. Review the current guide to see whether the draft saved before trying again."
            : "The server did not confirm whether the draft saved. Refresh the guide before saving it again.";
        }
        setError("cardError", message);
        return;
      }
      byId("cardDialog").close();
      const message = "Draft saved. Review and approve it before sharing.";
      toast(message);
      announce(message);
      try {
        await loadOwnerState();
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return;
        const warning = "The draft was saved, but the card list did not refresh. Refresh the guide before editing it.";
        setError("generateError", warning);
        announce(warning);
      }
    } finally {
      if (ownerSessionIsCurrent(ownerSessionGeneration)) {
        button.textContent = priorLabel;
        setCardSavePending(false);
      }
    }
  }

  async function addMemory(event) {
    event.preventDefault();
    if (state.draftGenerationPending || state.notePreviewPending) return;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    setError("memoryError");
    const memoryInput = byId("memoryIdInput");
    const submittedValue = memoryInput.value;
    const memoryId = submittedValue.trim();
    if (state.selectedNotes.some((note) => note.memoryId === memoryId)) {
      setError("memoryError", "That note is already selected.");
      return;
    }
    if (state.selectedNotes.length >= 20) {
      setError("memoryError", "Select no more than 20 notes.");
      return;
    }
    const button = event.currentTarget.querySelector("button");
    const priorLabel = button.textContent;
    setNotePreviewPending(true);
    button.textContent = "Adding note…";
    try {
      const preview = model.parseMemoryPreview(await api.fetchMemory(memoryId));
      if (!preview.found) {
        throw new Error("That memory was not found in your Remnic scope.");
      }
      if (preview.memory.id !== memoryId) throw new Error("The selected note response is invalid.");
      state.selectedNotes = [
        ...state.selectedNotes,
        {
          memoryId,
          content: preview.memory.content,
          revision: preview.memory.revision,
        },
      ];
      if (memoryInput.value === submittedValue) memoryInput.value = "";
      byId("consentInput").checked = false;
      renderSelectedNotes();
      announce("Selected note added. Review it before consent.");
    } catch (error) {
      setError("memoryError", errorMessage(error, "The selected note did not load."));
    } finally {
      if (ownerSessionIsCurrent(ownerSessionGeneration)) {
        button.textContent = priorLabel;
        setNotePreviewPending(false);
      }
    }
  }

  async function generateDrafts() {
    if (state.draftGenerationPending) return;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    setError("generateError");
    if (state.selectedNotes.length === 0) {
      setError("generateError", "Select at least one note first.");
      return;
    }
    if (state.notePreviewPending) {
      setError("generateError", "Wait for the selected note to finish loading before drafting.");
      return;
    }
    if (!byId("consentInput").checked) {
      setError("generateError", "Select the consent box before any model call.");
      byId("consentInput").focus();
      return;
    }
    const submittedNotes = state.selectedNotes.map((note) => ({ ...note }));
    const button = byId("generateButton");
    const priorLabel = button.textContent;
    setDraftGenerationPending(true);
    button.textContent = "Drafting cards…";
    try {
      try {
        await api.generateDrafts({
          sourceMemoryIds: submittedNotes.map((note) => note.memoryId),
          sourceMemoryRevisions: submittedNotes.map((note) => ({
            memoryId: note.memoryId,
            revision: note.revision,
          })),
          consent: true,
        });
      } catch (error) {
        if (error?.code !== "request_timeout") {
          setError("generateError", errorMessage(error, "The configured model did not return valid drafts."));
          return;
        }
        byId("consentInput").checked = false;
        let refreshed = false;
        try {
          await loadOwnerState();
          refreshed = true;
        } catch (error) {
          if (error === PAGE_HIDDEN_ABORT) return;
        }
        setError(
          "generateError",
          refreshed
            ? "Drafting timed out. Review the current guide before deciding whether to draft again."
            : "Drafting timed out. Refresh the guide before deciding whether to draft again."
        );
        return;
      }
      byId("consentInput").checked = false;
      const message = "Drafts ready. Review each card before approval.";
      toast(message);
      announce(message);
      try {
        await loadOwnerState();
        byId("reviewCards").scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: "start" });
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return;
        const warning = `${message} The card list did not refresh. Refresh the guide before another change.`;
        setError("generateError", warning);
        announce(warning);
      }
    } finally {
      if (ownerSessionIsCurrent(ownerSessionGeneration)) {
        button.textContent = priorLabel;
        setDraftGenerationPending(false);
      }
    }
  }

  function setDraftGenerationPending(pending) {
    state.draftGenerationPending = pending;
    syncDraftControls();
  }

  function setNotePreviewPending(pending) {
    state.notePreviewPending = pending;
    syncDraftControls();
  }

  function syncDraftControls() {
    byId("memoryIdInput").disabled = state.draftGenerationPending;
    byId("memoryForm").querySelector('button[type="submit"]').disabled =
      state.draftGenerationPending || state.notePreviewPending;
    byId("consentInput").disabled = state.draftGenerationPending || state.notePreviewPending;
    byId("generateButton").disabled = state.draftGenerationPending || state.notePreviewPending;
    renderSelectedNotes();
  }

  async function createShare(event) {
    event.preventDefault();
    if (state.shareCreationPending) return;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    setError("shareError");
    const selectedInputs = [...document.querySelectorAll('input[name="shareCard"]:checked')];
    const cardIds = selectedInputs.map((input) => input.value);
    if (cardIds.length === 0) {
      setError("shareError", "Select at least one approved support card.");
      return;
    }
    if (cardIds.some((cardId) => state.pendingCardMutationIds.has(cardId))) {
      setError("shareError", "Wait for the selected support card to finish changing before sharing it.");
      return;
    }
    if (cardIds.length > MAX_SHARED_CARDS) {
      setError("shareError", "Select no more than eight approved support cards.");
      return;
    }
    const cardRevisions = selectedInputs.map((input) => ({
      cardId: input.value,
      revision: input.dataset.revision ?? "",
    }));
    if (cardRevisions.some((card) => !card.revision)) {
      setError("shareError", "A selected support card changed. Refresh the guide and select it again.");
      return;
    }
    const choice = document.querySelector('input[name="duration"]:checked')?.value ?? "2h";
    let expiry;
    try {
      expiry = model.expiryForChoice(choice, byId("customTimeInput").value, ownerNowMs());
    } catch (error) {
      setError("shareError", errorMessage(error, "Choose a valid share time."));
      return;
    }
    clearDisplayedShareLink();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const priorLabel = button.textContent;
    let clearSelection = false;
    setShareCreationPending(true, selectedInputs);
    button.disabled = true;
    button.textContent = "Creating link…";
    try {
      let created;
      try {
        created = model.parseCreatedGrant(await api.createGrant({ cardIds, cardRevisions, ...expiry }));
      } catch (error) {
        if (error?.code !== "request_timeout") {
          setError("shareError", errorMessage(error, "The share link was not created."));
          return;
        }
        let refreshed = false;
        try {
          await loadOwnerState();
          refreshed = true;
        } catch (error) {
          if (error === PAGE_HIDDEN_ABORT) return;
        }
        setError(
          "shareError",
          refreshed
            ? "The server did not confirm whether it created a link. Review the live share list and stop any link you do not recognize before creating another."
            : "The server did not confirm whether it created a link. Refresh the guide and review live shares before creating another."
        );
        return;
      }
      const url = model.buildShareUrl(window.location.href, created.grantId, created.secret, replayMode);
      clearSelection = true;
      state.displayedGrant = {
        grantId: created.grantId,
        expiresAt: created.expiresAt,
        cards: cardRevisions.map((card) => ({ ...card })),
      };
      byId("shareLinkInput").value = url;
      byId("openLinkButton").href = url;
      byId("newLinkPanel").hidden = false;
      scheduleDisplayedShareLinkExpiry();
      const message = `Share link created. It ends ${model.formatDate(created.expiresAt)}.`;
      toast(message);
      announce(message);
      byId("newLinkPanel").scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: "nearest" });
      try {
        await loadOwnerState();
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return;
        setError("shareError", "The share link was created, but the share list did not refresh. Use the link above.");
      }
    } finally {
      if (ownerSessionIsCurrent(ownerSessionGeneration)) {
        setShareCreationPending(false);
        if (clearSelection) {
          for (const input of document.querySelectorAll('input[name="shareCard"]')) input.checked = false;
          updateShareCardChoices();
        }
        button.disabled = false;
        button.textContent = priorLabel;
      }
    }
  }

  async function copyShareLink() {
    const value = byId("shareLinkInput").value;
    try {
      await navigator.clipboard.writeText(value);
      toast("Share link copied.");
      announce("Share link copied.");
    } catch {
      byId("shareLinkInput").focus();
      byId("shareLinkInput").select();
      setError("shareError", "Copy the selected share link manually.");
    }
  }

  async function connectOwner(event) {
    event.preventDefault();
    setError("connectError");
    state.ownerLifecyclePaused = false;
    const ownerSessionGeneration = state.ownerSessionGeneration;
    state.token = byId("tokenInput").value.trim();
    if (!state.token) return;
    const button = event.currentTarget.querySelector("button");
    try {
      await withBusy(button, "Opening guide…", loadOwnerState);
      if (!ownerSessionIsCurrent(ownerSessionGeneration)) return;
      showOwner();
      announce("Owner guide loaded.");
    } catch (error) {
      if (!ownerSessionIsCurrent(ownerSessionGeneration)) return;
      state.token = "";
      setError("connectError", errorMessage(error, "The owner guide did not load."));
    }
  }

  function clearHelperSensitiveView() {
    byId("questionForm").reset();
    byId("questionInput").disabled = false;
    byId("questionCount").textContent = "0";
    byId("answerCopy").textContent = "";
    byId("answerPanel").hidden = true;
    clear(byId("citationList"));
    setError("questionError");
  }

  function showLocked(error) {
    if (state.helperLifecyclePaused && error?.code !== "session_ended") return;
    window.clearTimeout(state.helperExpiryTimer);
    state.helperExpiryTimer = null;
    window.clearTimeout(state.helperRevalidationTimer);
    state.helperRevalidationTimer = null;
    state.helperLoadController?.abort();
    state.helperLoadController = null;
    state.helperQuestionController?.abort();
    state.helperQuestionController = null;
    state.helperRevalidationController?.abort();
    state.helperRevalidationController = null;
    state.helperViewGeneration += 1;
    const lastGuide = state.guide;
    state.guide = null;
    byId("connectPanel")?.remove();
    byId("ownerView")?.remove();
    byId("helperView").hidden = true;
    byId("helperLoading").hidden = false;
    clear(byId("guideGroups"));
    clearHelperSensitiveView();
    const helperNow = Date.now() + (state.helperServerOffsetMs ?? 0);
    const lock = model.lockState(error, lastGuide, helperNow);
    const retryable =
      Boolean(state.helperGrantId && state.helperSecret) && !TERMINAL_HELPER_ERROR_CODES.has(error?.code);
    byId("lockedEyebrow").textContent = lock.eyebrow;
    byId("lockedTitle").textContent = lock.title;
    byId("lockedDetail").textContent = lock.detail;
    byId("retryHelperButton").hidden = !retryable;
    byId("lockedView").hidden = false;
    byId("viewMarkerText").textContent = "Locked helper view";
    document.title = "Share link locked · What Helps Me";
    byId("lockedTitle").focus?.();
    announce(lock.title);
  }

  async function readHelperGuide(signal) {
    const result = await api.readGrant(state.helperGrantId, state.helperSecret, signal);
    if (state.helperLifecyclePaused) throw PAGE_HIDDEN_ABORT;
    if (replayMode) return model.parsePublicGuide(result);
    if (Number.isFinite(result.serverOffsetMs)) state.helperServerOffsetMs = result.serverOffsetMs;
    return model.parsePublicGuide(result.payload);
  }

  function scheduleHelperExpiry() {
    window.clearTimeout(state.helperExpiryTimer);
    state.helperExpiryTimer = null;
    if (!state.guide || state.helperLifecyclePaused) return;
    const serverNow = Date.now() + (state.helperServerOffsetMs ?? 0);
    const remainingMs = Date.parse(state.guide.expiresAt) - serverNow;
    if (remainingMs <= 0 && !replayMode && state.helperServerOffsetMs === null) return;
    if (remainingMs <= 0) {
      const error = new Error("The share link has expired.");
      error.code = "grant_expired";
      showLocked(error);
      return;
    }
    state.helperExpiryTimer = window.setTimeout(() => {
      const error = new Error("The share link has expired.");
      error.code = "grant_expired";
      showLocked(error);
    }, remainingMs);
  }

  function renderGuide(guide) {
    byId("helperLoading").hidden = true;
    byId("helperExpiry").textContent = model.formatDate(guide.expiresAt);
    byId("helperCardCount").textContent = `${guide.cards.length} card${guide.cards.length === 1 ? "" : "s"}`;
    const groupsNode = byId("guideGroups");
    clear(groupsNode);
    for (const group of model.groupCards(guide.cards)) {
      const section = element("section", "guide-group");
      section.append(element("h3", "", group.label));
      for (const card of group.cards) {
        const article = element("article", "public-card");
        article.dataset.category = card.category;
        article.dataset.cardId = card.cardId;
        article.append(element("h3", "", card.title), element("p", "", card.statement));
        section.append(article);
      }
      groupsNode.append(section);
    }
    scheduleHelperExpiry();
  }

  function scheduleHelperRevalidation() {
    window.clearTimeout(state.helperRevalidationTimer);
    state.helperRevalidationTimer = null;
    if (replayMode || !state.guide || state.helperLifecyclePaused) return;
    state.helperRevalidationTimer = window.setTimeout(revalidateHelper, state.helperRevalidationDelayMs);
  }

  async function revalidateHelper() {
    state.helperRevalidationTimer = null;
    if (!state.guide || state.helperLifecyclePaused) return;
    const helperViewGeneration = state.helperViewGeneration;
    const controller = new AbortController();
    state.helperRevalidationController?.abort();
    state.helperRevalidationController = controller;
    const timeout = window.setTimeout(() => controller.abort(HELPER_READ_TIMEOUT_ABORT), HELPER_READ_TIMEOUT_MS);
    try {
      const guide = await readHelperGuide(controller.signal);
      if (state.helperLifecyclePaused || helperViewGeneration !== state.helperViewGeneration) return;
      state.guide = guide;
      state.helperRevalidationDelayMs = HELPER_REVALIDATION_MS;
      scheduleHelperExpiry();
    } catch (error) {
      if (
        state.helperLifecyclePaused ||
        helperViewGeneration !== state.helperViewGeneration ||
        controller.signal.reason === PAGE_HIDDEN_ABORT ||
        !state.guide
      )
        return;
      if (controller.signal.aborted) {
        if (controller.signal.reason !== HELPER_READ_TIMEOUT_ABORT) return;
        showLocked(HELPER_READ_TIMEOUT_ABORT);
        return;
      }
      if (["grant_expired", "grant_gone", "grant_not_found", "grant_stale"].includes(error?.code)) {
        showLocked(error);
        return;
      }
      if (error?.code === "rate_limited") {
        state.helperRevalidationDelayMs = Math.min(state.helperRevalidationDelayMs * 2, HELPER_REVALIDATION_MAX_MS);
      }
    } finally {
      window.clearTimeout(timeout);
      if (
        state.helperRevalidationController === controller &&
        helperViewGeneration === state.helperViewGeneration
      ) {
        state.helperRevalidationController = null;
        scheduleHelperRevalidation();
      }
    }
  }

  async function loadHelper() {
    const helperViewGeneration = ++state.helperViewGeneration;
    byId("connectPanel")?.remove();
    byId("ownerView")?.remove();
    byId("lockedView").hidden = true;
    byId("retryHelperButton").hidden = true;
    byId("helperView").hidden = false;
    byId("viewMarkerText").textContent = replayMode ? "Helper replay" : "Helper view";
    document.title = "Shared support passport · What Helps Me";
    if (!state.helperGrantId || !state.helperSecret) {
      const error = new Error("The share link is incomplete.");
      error.code = "missing_link";
      showLocked(error);
      return;
    }
    const controller = new AbortController();
    state.helperLoadController?.abort();
    state.helperLoadController = controller;
    const timeout = window.setTimeout(() => controller.abort(HELPER_READ_TIMEOUT_ABORT), HELPER_READ_TIMEOUT_MS);
    try {
      if (replayMode) {
        const sharedState = await requestReplaySharedGuide();
        replayStore.seedSharedGuide(state.helperGrantId, state.helperSecret, sharedState);
      }
      const guide = await readHelperGuide(controller.signal);
      if (state.helperLifecyclePaused || helperViewGeneration !== state.helperViewGeneration) return;
      state.guide = guide;
      renderGuide(state.guide);
      if (!state.guide) return;
      scheduleHelperRevalidation();
      announce(`Support passport loaded with ${state.guide.cards.length} cards.`);
    } catch (error) {
      if (
        state.helperLifecyclePaused ||
        helperViewGeneration !== state.helperViewGeneration ||
        error === PAGE_HIDDEN_ABORT ||
        controller.signal.reason === PAGE_HIDDEN_ABORT
      )
        return;
      showLocked(controller.signal.reason === HELPER_READ_TIMEOUT_ABORT ? HELPER_READ_TIMEOUT_ABORT : error);
    } finally {
      window.clearTimeout(timeout);
      if (state.helperLoadController === controller) state.helperLoadController = null;
    }
  }

  async function askQuestion(event) {
    event.preventDefault();
    setError("questionError");
    const questionInput = byId("questionInput");
    const question = questionInput.value.trim();
    if (!question || !state.guide) return;
    byId("answerPanel").hidden = true;
    byId("answerCopy").textContent = "";
    clear(byId("citationList"));
    const button = event.currentTarget.querySelector("button");
    const priorLabel = "Ask from this guide";
    const controller = new AbortController();
    state.helperQuestionController?.abort();
    state.helperQuestionController = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HELPER_QUESTION_TIMEOUT_MS);
    questionInput.disabled = true;
    button.disabled = true;
    button.textContent = "Checking shared cards…";
    try {
      const payload = await api.askGrant(state.helperGrantId, state.helperSecret, question, controller.signal);
      if (state.helperLifecyclePaused || state.helperQuestionController !== controller) return;
      const answer = model.parseAnswer(payload, state.guide);
      byId("answerCopy").textContent = answer.answer;
      const citations = byId("citationList");
      clear(citations);
      for (const cardId of answer.citedCardIds) {
        const card = state.guide.cards.find((candidate) => candidate.cardId === cardId);
        citations.append(element("div", "citation", `Support card · ${card?.title ?? cardId}`));
      }
      if (answer.citedCardIds.length === 0)
        citations.append(element("div", "citation", "No support card covers this question."));
      byId("answerPanel").hidden = false;
      byId("answerPanel").focus();
      announce("Answer ready with support card citations.");
    } catch (error) {
      if (!state.guide) return;
      if (state.helperQuestionController !== controller) return;
      if (state.helperLifecyclePaused || error === PAGE_HIDDEN_ABORT || controller.signal.reason === PAGE_HIDDEN_ABORT)
        return;
      if (timedOut) {
        setError("questionError", "The question took too long. Try again.");
        return;
      }
      if (["grant_expired", "grant_gone", "grant_not_found", "grant_stale"].includes(error?.code)) {
        showLocked(error);
        return;
      }
      setError("questionError", errorMessage(error, "The question did not complete."));
    } finally {
      window.clearTimeout(timeout);
      if (state.helperQuestionController === controller) {
        state.helperQuestionController = null;
        questionInput.disabled = false;
        button.disabled = false;
        button.textContent = priorLabel;
      }
    }
  }

  function clearPrefillToken() {
    try {
      delete window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__;
    } catch {
      window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__ = "";
    }
    for (const script of document.scripts) {
      if (script.src || !script.textContent?.includes("__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__")) continue;
      script.textContent = "";
      script.remove();
    }
  }

  function bindOwnerEvents() {
    byId("memoryForm").addEventListener("submit", addMemory);
    byId("generateButton").addEventListener("click", generateDrafts);
    byId("newCardButton").addEventListener("click", () => openCardDialog());
    byId("cardForm").addEventListener("submit", saveCard);
    byId("cardDialogClose").addEventListener("click", closeCardDialog);
    byId("cardCancelButton").addEventListener("click", closeCardDialog);
    byId("cardDialog").addEventListener("cancel", (event) => {
      if (state.cardSavePending) event.preventDefault();
    });
    byId("shareForm").addEventListener("submit", createShare);
    byId("copyLinkButton").addEventListener("click", copyShareLink);
    byId("refreshButton").addEventListener("click", async (event) => {
      try {
        await withBusy(event.currentTarget, "…", loadOwnerState);
        announce("Cards and share links refreshed.");
      } catch (error) {
        if (error === PAGE_HIDDEN_ABORT) return;
        setError("shareError", errorMessage(error, "The guide did not refresh."));
      }
    });
    for (const input of document.querySelectorAll('input[name="duration"]')) {
      input.addEventListener("change", () => {
        byId("customTimeField").hidden = input.value !== "custom" || !input.checked;
      });
    }
    window.addEventListener("pagehide", () => {
      clearOwnerSession();
    });
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      if (replayMode) {
        window.location.reload();
        return;
      }
      clearOwnerSession();
    });
  }

  function clearOwnerSession() {
    state.ownerLifecyclePaused = true;
    state.ownerSessionGeneration += 1;
    state.ownerLoadGeneration += 1;
    for (const controller of state.ownerRequestControllers) controller.abort(PAGE_HIDDEN_ABORT);
    state.ownerRequestControllers.clear();
    state.ownerServerOffsetMs = null;
    state.token = "";
    state.cards = [];
    state.grants = [];
    state.selectedNotes = [];
    state.pendingCardMutationIds.clear();
    state.pendingGrantRevocationIds.clear();
    state.cardSavePending = false;
    state.notePreviewPending = false;
    state.draftGenerationPending = false;
    state.shareCreationPending = false;
    state.shareCreationCardIds = null;
    clearDisplayedShareLink();
    window.clearTimeout(state.ownerGrantExpiryTimer);
    state.ownerGrantExpiryTimer = null;
    clearPrefillToken();
    window.clearTimeout(state.announcementTimer);
    state.announcementTimer = null;
    window.clearTimeout(state.toastTimer);
    byId("connectForm").reset();
    byId("memoryForm").reset();
    byId("memoryForm").querySelector('button[type="submit"]').textContent = "Add selected note";
    byId("generateButton").textContent = "Draft my support cards";
    byId("cardForm").reset();
    byId("shareForm").reset();
    byId("shareForm").querySelector('button[type="submit"]').textContent = "Create share link";
    byId("customTimeField").hidden = true;
    if (byId("cardDialog").open) byId("cardDialog").close();
    byId("toast").textContent = "";
    byId("toast").classList.remove("visible");
    byId("announcer").textContent = "";
    for (const id of ["connectError", "memoryError", "generateError", "cardError", "shareError"]) setError(id);
    setCardSavePending(false);
    setDraftGenerationPending(false);
    setShareCreationPending(false);
    renderSelectedNotes();
    renderCards();
    renderShareCards();
    renderGrants();
    byId("ownerView").hidden = true;
    byId("connectPanel").hidden = false;
    byId("viewMarkerText").textContent = "Owner view";
  }

  function bindHelperEvents() {
    byId("retryHelperButton").addEventListener("click", async (event) => {
      await withBusy(event.currentTarget, "Trying again…", loadHelper);
    });
    byId("questionForm").addEventListener("submit", askQuestion);
    byId("questionInput").addEventListener("input", () => {
      byId("questionCount").textContent = String(byId("questionInput").value.length);
    });
    replayChannel?.addEventListener("message", (event) => {
      if (event.data?.type === "grant-revoked" && event.data.grantId === state.helperGrantId) {
        const error = new Error("The share link is no longer active.");
        error.code = "grant_gone";
        showLocked(error);
        return;
      }
      if (
        event.data?.type === "cards-stale" &&
        Array.isArray(event.data.cardIds) &&
        state.guide?.cards.some((card) => event.data.cardIds.includes(card.cardId))
      ) {
        const error = new Error("The shared support guide has changed.");
        error.code = "grant_stale";
        showLocked(error);
      }
    });
    window.addEventListener("pagehide", (event) => {
      clearHelperSession();
      if (!event.persisted) replayChannel?.close();
    });
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      clearHelperSession();
    });
  }

  function clearHelperSession() {
    state.helperLifecyclePaused = true;
    window.clearTimeout(state.announcementTimer);
    state.announcementTimer = null;
    state.helperLoadController?.abort(PAGE_HIDDEN_ABORT);
    state.helperQuestionController?.abort(PAGE_HIDDEN_ABORT);
    state.helperRevalidationController?.abort(PAGE_HIDDEN_ABORT);
    state.helperSecret = "";
    state.helperServerOffsetMs = null;
    state.helperRevalidationDelayMs = HELPER_REVALIDATION_MS;
    const error = new Error("The helper session ended when this page was hidden.");
    error.code = "session_ended";
    showLocked(error);
    byId("helperExpiry").textContent = "";
    byId("helperCardCount").textContent = "";
  }

  async function init() {
    if (replayMode) byId("replayBanner").hidden = false;
    if (grantId || hasSecretFragment) {
      clearPrefillToken();
      bindHelperEvents();
      await loadHelper();
      return;
    }

    bindOwnerEvents();
    const prefillValue = window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__;
    const prefill = typeof prefillValue === "string" ? prefillValue.trim() : "";
    clearPrefillToken();
    if (replayMode) {
      state.token = "synthetic-replay";
      state.selectedNotes = replayStore.notes.map((note) => ({ ...note }));
      renderSelectedNotes();
      await loadOwnerState();
      showOwner();
      bindReplayOwnerBridge();
      return;
    }
    if (prefill) byId("tokenInput").value = prefill;
    byId("connectForm").addEventListener("submit", connectOwner);
  }

  void init().catch((error) => {
    if (grantId || hasSecretFragment) showLocked(error);
    else setError("connectError", errorMessage(error, "The support passport did not start."));
  });
})();
