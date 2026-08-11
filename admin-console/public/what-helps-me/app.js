(function startWhatHelpsMe() {
  const model = window.WhatHelpsMeModel;
  if (!model) throw new Error("What Helps Me model did not load.");

  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const replayMode = params.get("mode") === "replay";
  const grantId = params.get("grant") ?? "";
  const hasSecretFragment = new URLSearchParams(window.location.hash.slice(1)).has("secret");
  const secret = model.parseSecret(window.location.hash);
  if (hasSecretFragment) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const replayStore = replayMode ? model.createReplayStore() : null;
  const replayChannel =
    replayMode && "BroadcastChannel" in window ? new BroadcastChannel("remnic-what-helps-me-replay") : null;
  const HELPER_REVALIDATION_MS = 15_000;

  const state = {
    token: "",
    cards: [],
    grants: [],
    selectedNotes: [],
    guide: null,
    helperSecret: secret,
    helperGrantId: grantId,
    helperExpiryTimer: null,
    helperQuestionController: null,
    helperRevalidationController: null,
    helperRevalidationTimer: null,
    toastTimer: null,
  };

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
    byId(id).textContent = message;
  }

  function announce(message) {
    byId("announcer").textContent = "";
    window.setTimeout(() => {
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
    const headers = new Headers(options.headers ?? {});
    headers.set("accept", "application/json");
    if (options.owner) headers.set("authorization", `Bearer ${state.token}`);
    if (options.secret) headers.set("authorization", `SupportPassport ${options.secret}`);
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    }
    if (!response.ok) {
      const error = new Error(
        typeof payload.error === "string" ? payload.error : `The server returned HTTP ${response.status}.`
      );
      error.code = typeof payload.code === "string" ? payload.code : "request_failed";
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const liveApi = {
    listCards: () => fetchJson("/engram/v1/support-passport/cards", { owner: true }),
    listGrants: () => fetchJson("/engram/v1/support-passport/grants", { owner: true }),
    fetchMemory: (memoryId) => fetchJson(`/engram/v1/memories/${encodeURIComponent(memoryId)}`, { owner: true }),
    createManualDraft: (input) =>
      fetchJson("/engram/v1/support-passport/drafts", { owner: true, method: "POST", body: input }),
    generateDrafts: (input) =>
      fetchJson("/engram/v1/support-passport/drafts/generate", { owner: true, method: "POST", body: input }),
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
      return { found: true, memory: { id: note.memoryId, content: note.content } };
    },
  };
  const api = replayMode ? replayApi : liveApi;

  function showOwner() {
    byId("connectPanel").hidden = true;
    byId("helperView").remove();
    byId("lockedView").remove();
    byId("ownerView").hidden = false;
    byId("viewMarkerText").textContent = replayMode ? "Owner replay" : "Owner view";
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
    setError("generateError");
    const verbs = { approve: "Approving…", reject: "Rejecting…", withdraw: "Stopping…" };
    try {
      await withBusy(button, verbs[action], () =>
        api.mutateCard(
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
        )
      );
      await loadOwnerState();
      const message =
        action === "approve"
          ? `Approved ${card.title}. It can now be shared.`
          : action === "reject"
            ? `Rejected ${card.title}. It stays private.`
            : `Withdrew ${card.title}. Existing links will lock.`;
      toast(message);
      announce(message);
    } catch (error) {
      setError("generateError", errorMessage(error, "The support card did not change."));
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
      const copy = element("span");
      copy.append(element("strong", "", card.title), element("small", "", card.statement));
      label.append(input, copy);
      list.append(label);
    }
  }

  function renderGrants() {
    const list = byId("grantList");
    clear(list);
    byId("grantsEmpty").hidden = state.grants.length > 0;
    for (const grant of state.grants) {
      const article = element("article", "grant-card");
      const stateText =
        grant.status === "active" ? "Live share" : grant.status === "revoked" ? "Sharing stopped" : "Share time ended";
      article.append(
        element("p", "", stateText),
        element(
          "div",
          "grant-meta",
          `${grant.cards.length} card${grant.cards.length === 1 ? "" : "s"} · Ends ${model.formatDate(grant.expiresAt)}`
        )
      );
      if (grant.status === "active") {
        const stop = cardButton("Stop sharing", "button-danger", async (event) => {
          try {
            await withBusy(event.currentTarget, "Stopping sharing…", () =>
              api.revokeGrant(grant.grantId, { expectedVersion: grant.stateVersion })
            );
            replayChannel?.postMessage({ type: "grant-revoked", grantId: grant.grantId });
            await loadOwnerState();
            const message = "Sharing stopped. The helper link is now locked.";
            toast(message);
            announce(message);
          } catch (error) {
            setError("shareError", errorMessage(error, "The share link did not stop."));
          }
        });
        article.append(stop);
      }
      list.append(article);
    }
  }

  async function loadOwnerState() {
    const [cardPayload, grantPayload] = await Promise.all([api.listCards(), api.listGrants()]);
    state.cards = model.parseCardList(cardPayload);
    state.grants = model.parseGrantList(grantPayload);
    renderCards();
    renderShareCards();
    renderGrants();
  }

  function toLocalInputValue(date) {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function openCardDialog(card = null) {
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
    byId("cardDialog").close();
  }

  async function saveCard(event) {
    event.preventDefault();
    setError("cardError");
    const cardId = byId("cardIdInput").value;
    const expectedRevision = byId("cardRevisionInput").value;
    const reviewDate = new Date(byId("cardReviewInput").value);
    if (!Number.isFinite(reviewDate.getTime()) || reviewDate.getTime() <= Date.now()) {
      setError("cardError", "Choose a future review reminder.");
      return;
    }
    const input = {
      title: byId("cardTitleInput").value.trim(),
      statement: byId("cardStatementInput").value.trim(),
      category: byId("cardCategoryInput").value,
      reviewBy: reviewDate.toISOString(),
      ...(cardId ? { expectedRevision } : {}),
    };
    try {
      await withBusy(byId("cardSaveButton"), "Saving draft…", () =>
        cardId ? api.replaceCard(cardId, input) : api.createManualDraft(input)
      );
      closeCardDialog();
      await loadOwnerState();
      const message = "Draft saved. Review and approve it before sharing.";
      toast(message);
      announce(message);
    } catch (error) {
      setError("cardError", errorMessage(error, "The draft did not save."));
    }
  }

  async function addMemory(event) {
    event.preventDefault();
    setError("memoryError");
    const memoryId = byId("memoryIdInput").value.trim();
    if (state.selectedNotes.some((note) => note.memoryId === memoryId)) {
      setError("memoryError", "That note is already selected.");
      return;
    }
    if (state.selectedNotes.length >= 20) {
      setError("memoryError", "Select no more than 20 notes.");
      return;
    }
    const button = event.currentTarget.querySelector("button");
    try {
      const payload = await withBusy(button, "Adding note…", () => api.fetchMemory(memoryId));
      if (payload.found !== true || !payload.memory || typeof payload.memory.content !== "string") {
        throw new Error("That memory was not found in your Remnic scope.");
      }
      state.selectedNotes = [...state.selectedNotes, { memoryId, content: payload.memory.content }];
      byId("memoryIdInput").value = "";
      byId("consentInput").checked = false;
      renderSelectedNotes();
      announce("Selected note added. Review it before consent.");
    } catch (error) {
      setError("memoryError", errorMessage(error, "The selected note did not load."));
    }
  }

  async function generateDrafts() {
    setError("generateError");
    if (state.selectedNotes.length === 0) {
      setError("generateError", "Select at least one note first.");
      return;
    }
    if (!byId("consentInput").checked) {
      setError("generateError", "Select the consent box before any model call.");
      byId("consentInput").focus();
      return;
    }
    try {
      await withBusy(byId("generateButton"), "Drafting cards…", () =>
        api.generateDrafts({
          sourceMemoryIds: state.selectedNotes.map((note) => note.memoryId),
          consent: true,
        })
      );
      byId("consentInput").checked = false;
      await loadOwnerState();
      byId("reviewCards").scrollIntoView({ behavior: "smooth", block: "start" });
      const message = "Drafts ready. Review each card before approval.";
      toast(message);
      announce(message);
    } catch (error) {
      setError("generateError", errorMessage(error, "The configured model did not return valid drafts."));
    }
  }

  async function createShare(event) {
    event.preventDefault();
    setError("shareError");
    const cardIds = [...document.querySelectorAll('input[name="shareCard"]:checked')].map((input) => input.value);
    if (cardIds.length === 0) {
      setError("shareError", "Select at least one approved support card.");
      return;
    }
    const choice = document.querySelector('input[name="duration"]:checked')?.value ?? "2h";
    let expiresAt;
    try {
      expiresAt = model.expiryForChoice(choice, byId("customTimeInput").value);
    } catch (error) {
      setError("shareError", errorMessage(error, "Choose a valid share time."));
      return;
    }
    const button = event.currentTarget.querySelector('button[type="submit"]');
    try {
      const created = await withBusy(button, "Creating link…", () => api.createGrant({ cardIds, expiresAt }));
      const url = model.buildShareUrl(window.location.href, created.grantId, created.secret, replayMode);
      byId("shareLinkInput").value = url;
      byId("openLinkButton").href = url;
      byId("newLinkPanel").hidden = false;
      await loadOwnerState();
      const message = `Share link created. It ends ${model.formatDate(created.expiresAt)}.`;
      toast(message);
      announce(message);
      byId("newLinkPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      setError("shareError", errorMessage(error, "The share link was not created."));
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
    state.token = byId("tokenInput").value.trim();
    if (!state.token) return;
    const button = event.currentTarget.querySelector("button");
    try {
      await withBusy(button, "Opening guide…", loadOwnerState);
      showOwner();
      announce("Owner guide loaded.");
    } catch (error) {
      state.token = "";
      setError("connectError", errorMessage(error, "The owner guide did not load."));
    }
  }

  function showLocked(error) {
    window.clearTimeout(state.helperExpiryTimer);
    state.helperExpiryTimer = null;
    window.clearTimeout(state.helperRevalidationTimer);
    state.helperRevalidationTimer = null;
    state.helperQuestionController?.abort();
    state.helperQuestionController = null;
    state.helperRevalidationController?.abort();
    state.helperRevalidationController = null;
    const lastGuide = state.guide;
    state.guide = null;
    byId("connectPanel")?.remove();
    byId("ownerView")?.remove();
    byId("helperView")?.remove();
    const lock = model.lockState(error, lastGuide);
    byId("lockedEyebrow").textContent = lock.eyebrow;
    byId("lockedTitle").textContent = lock.title;
    byId("lockedDetail").textContent = lock.detail;
    byId("lockedView").hidden = false;
    byId("viewMarkerText").textContent = "Locked helper view";
    document.title = "Share link locked · What Helps Me";
    byId("lockedTitle").focus?.();
    announce(lock.title);
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
    const remainingMs = Date.parse(guide.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      const error = new Error("The share link has expired.");
      error.code = "grant_expired";
      showLocked(error);
      return;
    }
    window.clearTimeout(state.helperExpiryTimer);
    state.helperExpiryTimer = window.setTimeout(() => {
      const error = new Error("The share link has expired.");
      error.code = "grant_expired";
      showLocked(error);
    }, remainingMs);
  }

  function scheduleHelperRevalidation() {
    window.clearTimeout(state.helperRevalidationTimer);
    state.helperRevalidationTimer = null;
    if (replayMode || !state.guide) return;
    state.helperRevalidationTimer = window.setTimeout(revalidateHelper, HELPER_REVALIDATION_MS);
  }

  async function revalidateHelper() {
    state.helperRevalidationTimer = null;
    if (!state.guide) return;
    const controller = new AbortController();
    state.helperRevalidationController?.abort();
    state.helperRevalidationController = controller;
    try {
      model.parsePublicGuide(await api.readGrant(state.helperGrantId, state.helperSecret, controller.signal));
    } catch (error) {
      if (controller.signal.aborted || !state.guide) return;
      if (["grant_expired", "grant_gone", "grant_not_found", "grant_stale"].includes(error?.code)) {
        showLocked(error);
        return;
      }
    } finally {
      if (state.helperRevalidationController === controller) {
        state.helperRevalidationController = null;
        scheduleHelperRevalidation();
      }
    }
  }

  async function loadHelper() {
    byId("connectPanel").remove();
    byId("ownerView").remove();
    byId("helperView").hidden = false;
    byId("viewMarkerText").textContent = replayMode ? "Helper replay" : "Helper view";
    document.title = "Shared support passport · What Helps Me";
    if (!state.helperGrantId || !state.helperSecret) {
      const error = new Error("The share link is incomplete.");
      error.code = "missing_link";
      showLocked(error);
      return;
    }
    if (replayMode) replayStore.seedSharedGuide(state.helperGrantId, state.helperSecret);
    try {
      state.guide = model.parsePublicGuide(await api.readGrant(state.helperGrantId, state.helperSecret));
      renderGuide(state.guide);
      if (!state.guide) return;
      scheduleHelperRevalidation();
      announce(`Support passport loaded with ${state.guide.cards.length} cards.`);
    } catch (error) {
      showLocked(error);
    }
  }

  async function askQuestion(event) {
    event.preventDefault();
    setError("questionError");
    const question = byId("questionInput").value.trim();
    if (!question || !state.guide) return;
    const button = event.currentTarget.querySelector("button");
    const controller = new AbortController();
    state.helperQuestionController?.abort();
    state.helperQuestionController = controller;
    try {
      const payload = await withBusy(button, "Checking shared cards…", () =>
        api.askGrant(state.helperGrantId, state.helperSecret, question, controller.signal)
      );
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
      if (["grant_expired", "grant_gone", "grant_not_found", "grant_stale"].includes(error?.code)) {
        showLocked(error);
        return;
      }
      setError("questionError", errorMessage(error, "The question did not complete."));
    } finally {
      if (state.helperQuestionController === controller) state.helperQuestionController = null;
    }
  }

  function bindOwnerEvents() {
    byId("memoryForm").addEventListener("submit", addMemory);
    byId("generateButton").addEventListener("click", generateDrafts);
    byId("newCardButton").addEventListener("click", () => openCardDialog());
    byId("cardForm").addEventListener("submit", saveCard);
    byId("cardDialogClose").addEventListener("click", closeCardDialog);
    byId("cardCancelButton").addEventListener("click", closeCardDialog);
    byId("shareForm").addEventListener("submit", createShare);
    byId("copyLinkButton").addEventListener("click", copyShareLink);
    byId("refreshButton").addEventListener("click", async (event) => {
      try {
        await withBusy(event.currentTarget, "…", loadOwnerState);
        announce("Cards and share links refreshed.");
      } catch (error) {
        setError("shareError", errorMessage(error, "The guide did not refresh."));
      }
    });
    for (const input of document.querySelectorAll('input[name="duration"]')) {
      input.addEventListener("change", () => {
        byId("customTimeField").hidden = input.value !== "custom" || !input.checked;
      });
    }
  }

  function bindHelperEvents() {
    byId("questionForm").addEventListener("submit", askQuestion);
    byId("questionInput").addEventListener("input", () => {
      byId("questionCount").textContent = String(byId("questionInput").value.length);
    });
    replayChannel?.addEventListener("message", (event) => {
      if (event.data?.type === "grant-revoked" && event.data.grantId === state.helperGrantId) {
        const error = new Error("The share link is no longer active.");
        error.code = "grant_gone";
        showLocked(error);
      }
    });
    window.addEventListener(
      "pagehide",
      () => {
        window.clearTimeout(state.helperExpiryTimer);
        window.clearTimeout(state.helperRevalidationTimer);
        state.helperQuestionController?.abort();
        state.helperRevalidationController?.abort();
        replayChannel?.close();
      },
      { once: true }
    );
  }

  async function init() {
    if (replayMode) byId("replayBanner").hidden = false;
    if (grantId || hasSecretFragment) {
      bindHelperEvents();
      await loadHelper();
      return;
    }

    bindOwnerEvents();
    const prefill =
      typeof window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__ === "string"
        ? window.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__.trim()
        : "";
    if (replayMode) {
      state.token = "synthetic-replay";
      state.selectedNotes = replayStore.notes.map((note) => ({ ...note }));
      renderSelectedNotes();
      await loadOwnerState();
      showOwner();
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
