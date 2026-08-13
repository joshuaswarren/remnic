(function attachWhatHelpsMeModel(globalScope) {
  const CARD_CATEGORIES = Object.freeze([
    "communication",
    "environment",
    "transitions",
    "sensory",
    "regulation",
    "interests",
    "other",
  ]);
  const CARD_STATUSES = Object.freeze(["pending_review", "active", "rejected", "superseded", "archived"]);
  const SHARE_REQUEST_MARGIN_MS = 60_000;
  const CATEGORY_LABELS = Object.freeze({
    communication: "Communication",
    environment: "Environment",
    transitions: "Changes and transitions",
    sensory: "Sensory comfort",
    regulation: "Feeling settled",
    interests: "Interests and connection",
    other: "Other support",
  });
  const LOCK_STATES = Object.freeze({
    bad_link: {
      key: "bad-link",
      eyebrow: "Share link not found",
      title: "This link does not open a support passport.",
      detail: "Ask the person who shared it for a new link.",
    },
    expired: {
      key: "expired",
      eyebrow: "Share time ended",
      title: "This share link has expired.",
      detail: "Ask the person for a new link if they still want to share.",
    },
    stopped: {
      key: "stopped",
      eyebrow: "Sharing stopped",
      title: "This support passport is locked.",
      detail: "The person controls this guide and has ended this share link.",
    },
    session_ended: {
      key: "session-ended",
      eyebrow: "Session ended",
      title: "This helper session ended.",
      detail: "Open the original share link again to view this support passport.",
    },
    stale: {
      key: "stale",
      eyebrow: "Guide changed",
      title: "This share link is no longer current.",
      detail: "Ask the person for a new link with the support cards they choose.",
    },
    error: {
      key: "error",
      eyebrow: "Guide unavailable",
      title: "The support passport did not load.",
      detail: "Check the connection and try this link again.",
    },
  });
  const REPLAY_NOTES = Object.freeze([
    Object.freeze({
      memoryId: "synthetic-note-light",
      content: "Bright lights make it hard for me to think.",
    }),
    Object.freeze({
      memoryId: "synthetic-note-change",
      content: "Tell me before plans change.",
    }),
    Object.freeze({
      memoryId: "synthetic-note-quiet",
      content: "If I stop speaking, offer a quiet place and time.",
    }),
  ]);
  const REPLAY_DRAFTS = Object.freeze([
    Object.freeze({
      title: "Lighting",
      statement: "Bright lights make it hard for me to think.",
      category: "sensory",
    }),
    Object.freeze({
      title: "Plan changes",
      statement: "Tell me before plans change.",
      category: "transitions",
    }),
    Object.freeze({
      title: "When I stop speaking",
      statement: "If I stop speaking, offer a quiet place and time.",
      category: "communication",
    }),
  ]);

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, keys) {
    if (!isObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function isIsoTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }

  function isMemoryId(value) {
    return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
  }

  function isGrantId(value) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
  }

  function isRevision(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  }

  function assertCard(value) {
    const keys = ["cardId", "title", "statement", "category", "status", "updatedAt", "reviewBy", "revision"];
    if (!hasExactKeys(value, keys)) throw new Error("The support card response has an unexpected shape.");
    if (
      !isMemoryId(value.cardId) ||
      typeof value.title !== "string" ||
      value.title.length < 1 ||
      value.title.length > 80
    ) {
      throw new Error("The support card response is invalid.");
    }
    if (typeof value.statement !== "string" || value.statement.length < 1 || value.statement.length > 500) {
      throw new Error("The support card response is invalid.");
    }
    if (!CARD_CATEGORIES.includes(value.category) || !CARD_STATUSES.includes(value.status)) {
      throw new Error("The support card response is invalid.");
    }
    if (!isIsoTimestamp(value.updatedAt) || !isIsoTimestamp(value.reviewBy) || !isRevision(value.revision)) {
      throw new Error("The support card response is invalid.");
    }
    return value;
  }

  function parseCardList(payload) {
    if (!hasExactKeys(payload, ["cards"]) || !Array.isArray(payload.cards) || payload.cards.length > 100) {
      throw new Error("The support card list has an unexpected shape.");
    }
    const cards = payload.cards.map(assertCard);
    if (new Set(cards.map((card) => card.cardId)).size !== cards.length) {
      throw new Error("The support card list contains duplicate cards.");
    }
    return cards;
  }

  function parseMemoryPreview(payload) {
    if (hasExactKeys(payload, ["found"]) && payload.found === false) return payload;
    if (!hasExactKeys(payload, ["found", "memory"]) || payload.found !== true) {
      throw new Error("The selected note response has an unexpected shape.");
    }
    if (
      !hasExactKeys(payload.memory, ["id", "content", "revision"]) ||
      !isMemoryId(payload.memory.id) ||
      typeof payload.memory.content !== "string" ||
      payload.memory.content.length < 1 ||
      payload.memory.content.length > 20_000 ||
      !isRevision(payload.memory.revision)
    ) {
      throw new Error("The selected note response is invalid.");
    }
    return payload;
  }

  function assertGrant(value) {
    const required = ["grantId", "stateVersion", "cards", "createdAt", "expiresAt", "status"];
    const optional = value?.revokedAt === undefined ? [] : ["revokedAt"];
    if (!hasExactKeys(value, [...required, ...optional]))
      throw new Error("The share link response has an unexpected shape.");
    if (
      typeof value.grantId !== "string" ||
      !Array.isArray(value.cards) ||
      value.cards.length < 1 ||
      value.cards.length > 8
    ) {
      throw new Error("The share link response is invalid.");
    }
    if (
      !Number.isInteger(value.stateVersion) ||
      value.stateVersion < 1 ||
      !["active", "expired", "revoked"].includes(value.status)
    ) {
      throw new Error("The share link response is invalid.");
    }
    if (
      !isIsoTimestamp(value.createdAt) ||
      !isIsoTimestamp(value.expiresAt) ||
      (value.revokedAt !== undefined && !isIsoTimestamp(value.revokedAt))
    ) {
      throw new Error("The share link response is invalid.");
    }
    for (const card of value.cards) {
      if (!hasExactKeys(card, ["cardId", "revision"]) || !isMemoryId(card.cardId) || !isRevision(card.revision)) {
        throw new Error("The share link response is invalid.");
      }
    }
    return value;
  }

  function parseGrantList(payload) {
    if (!hasExactKeys(payload, ["grants"]) || !Array.isArray(payload.grants)) {
      throw new Error("The share link list has an unexpected shape.");
    }
    return payload.grants.map(assertGrant);
  }

  function parseCreatedGrant(payload) {
    if (!hasExactKeys(payload, ["grantId", "secret", "expiresAt", "version"])) {
      throw new Error("The new share link response has an unexpected shape.");
    }
    if (
      !isGrantId(payload.grantId) ||
      typeof payload.secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.secret) ||
      !isIsoTimestamp(payload.expiresAt) ||
      !Number.isInteger(payload.version) ||
      payload.version < 1
    ) {
      throw new Error("The new share link response is invalid.");
    }
    return payload;
  }

  function assertPublicCard(value) {
    const keys = ["cardId", "title", "statement", "category", "updatedAt"];
    if (!hasExactKeys(value, keys) || !isMemoryId(value.cardId)) throw new Error("The public support card is invalid.");
    if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 80) {
      throw new Error("The public support card is invalid.");
    }
    if (typeof value.statement !== "string" || value.statement.length < 1 || value.statement.length > 500) {
      throw new Error("The public support card is invalid.");
    }
    if (!CARD_CATEGORIES.includes(value.category) || !isIsoTimestamp(value.updatedAt)) {
      throw new Error("The public support card is invalid.");
    }
    return value;
  }

  function parsePublicGuide(payload) {
    if (!hasExactKeys(payload, ["schemaVersion", "grantId", "expiresAt", "updatedAt", "cards"])) {
      throw new Error("The support passport response has an unexpected shape.");
    }
    if (payload.schemaVersion !== 1 || typeof payload.grantId !== "string") {
      throw new Error("The support passport response is invalid.");
    }
    if (!isIsoTimestamp(payload.expiresAt) || !isIsoTimestamp(payload.updatedAt) || !Array.isArray(payload.cards)) {
      throw new Error("The support passport response is invalid.");
    }
    const cards = payload.cards.map(assertPublicCard);
    if (cards.length < 1 || cards.length > 8 || new Set(cards.map((card) => card.cardId)).size !== cards.length) {
      throw new Error("The support passport response is invalid.");
    }
    return { ...payload, cards };
  }

  function parseAnswer(payload, guide) {
    if (!hasExactKeys(payload, ["answer", "citedCardIds", "coverage"])) {
      throw new Error("The helper answer has an unexpected shape.");
    }
    if (typeof payload.answer !== "string" || payload.answer.length < 1 || payload.answer.length > 800) {
      throw new Error("The helper answer is invalid.");
    }
    if (!Array.isArray(payload.citedCardIds) || !["grounded", "not_in_guide"].includes(payload.coverage)) {
      throw new Error("The helper answer is invalid.");
    }
    const allowed = new Set(guide.cards.map((card) => card.cardId));
    if (payload.citedCardIds.length > 8 || payload.citedCardIds.some((cardId) => !allowed.has(cardId))) {
      throw new Error("The helper answer cites a card outside this guide.");
    }
    if (new Set(payload.citedCardIds).size !== payload.citedCardIds.length) {
      throw new Error("The helper answer contains duplicate citations.");
    }
    if (payload.coverage === "grounded" && payload.citedCardIds.length === 0) {
      throw new Error("The helper answer needs a support card citation.");
    }
    if (payload.coverage === "not_in_guide" && payload.citedCardIds.length !== 0) {
      throw new Error("An uncovered answer cannot cite a support card.");
    }
    return payload;
  }

  function parseSecret(hash) {
    if (typeof hash !== "string" || !hash.startsWith("#")) return "";
    const params = new URLSearchParams(hash.slice(1));
    if ([...params.keys()].some((key) => key !== "secret")) return "";
    const secret = params.get("secret") ?? "";
    return /^[A-Za-z0-9_-]{32,256}$/.test(secret) ? secret : "";
  }

  function buildShareUrl(currentUrl, grantId, secret, replay, replayChannelId = "") {
    const url = new URL(currentUrl);
    url.pathname = "/remnic/ui/what-helps-me/";
    url.search = "";
    url.hash = "";
    url.searchParams.set("grant", grantId);
    if (replay) {
      url.searchParams.set("mode", "replay");
      url.searchParams.set("replayChannel", replayChannelId);
    }
    url.hash = `secret=${encodeURIComponent(secret)}`;
    return url.toString();
  }

  function lockState(error, lastGuide, now = Date.now()) {
    const code = typeof error?.code === "string" ? error.code : "";
    if (code === "grant_stale") return LOCK_STATES.stale;
    if (code === "grant_not_found" || code === "missing_link") return LOCK_STATES.bad_link;
    if (code === "grant_expired") return LOCK_STATES.expired;
    if (code === "session_ended") return LOCK_STATES.session_ended;
    if (code === "grant_gone") {
      return lastGuide && Date.parse(lastGuide.expiresAt) <= now ? LOCK_STATES.expired : LOCK_STATES.stopped;
    }
    return LOCK_STATES.error;
  }

  function groupCards(cards) {
    const groups = [];
    for (const category of CARD_CATEGORIES) {
      const matches = cards.filter((card) => card.category === category);
      if (matches.length > 0) groups.push({ category, label: CATEGORY_LABELS[category], cards: matches });
    }
    return groups;
  }

  function expiryForChoice(choice, customValue, now = Date.now()) {
    const durations = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "1d": 24 * 60 * 60_000 };
    if (Object.hasOwn(durations, choice)) return { durationMs: durations[choice] };
    const timestamp = Date.parse(customValue);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < now + 300_000 + SHARE_REQUEST_MARGIN_MS ||
      timestamp > now + 7 * 24 * 60 * 60_000
    ) {
      throw new Error("Choose a share time at least six minutes from now and no more than seven days away.");
    }
    return { expiresAt: new Date(timestamp).toISOString() };
  }

  function formatDate(value) {
    if (!isIsoTimestamp(value)) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function replayRevision(seed) {
    let output = "";
    let value = 2166136261;
    for (let index = 0; index < seed.length; index += 1) {
      value ^= seed.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    for (let index = 0; index < 8; index += 1) {
      value = Math.imul(value ^ index, 2246822519);
      output += (value >>> 0).toString(16).padStart(8, "0");
    }
    return output;
  }

  function replayId(prefix) {
    if (!globalScope.crypto?.getRandomValues) {
      throw new Error("Synthetic replay needs a secure browser context.");
    }
    const bytes = new Uint8Array(8);
    globalScope.crypto.getRandomValues(bytes);
    return `${prefix}-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  async function replaySecretProof(secret, requestId, grantId) {
    const key = await globalScope.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await globalScope.crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${requestId}:${grantId}`)
    );
    return [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function equalReplayProof(left, right) {
    if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  function hasMatchingTransitionIntent(cardText, question) {
    const intents = [
      /\bplans?\b/i,
      /\bschedul(?:e|es|ed|ing)\b/i,
      /\broutines?\b/i,
      /\b(?:changes|transitions?|transitioning)\b/i,
    ];
    return intents.some((intent) => intent.test(cardText) && intent.test(question));
  }

  function createReplayStore(now = () => new Date()) {
    let cards = [];
    let grants = [];
    const secrets = new Map();
    const replacements = new Map();

    function makeCard(input, status = "pending_review") {
      const updatedAt = now().toISOString();
      const cardId = replayId("replay-card");
      const reviewBy = input.reviewBy || new Date(now().getTime() + 180 * 24 * 60 * 60_000).toISOString();
      return {
        cardId,
        title: input.title,
        statement: input.statement,
        category: input.category,
        status,
        updatedAt,
        reviewBy,
        revision: replayRevision(`${cardId}:${status}:${updatedAt}:${input.statement}`),
      };
    }

    function publicGuide(grant) {
      const selected = grant.cards.map((reference) =>
        cards.find((card) => card.cardId === reference.cardId && card.revision === reference.revision)
      );
      if (selected.length === 0 || selected.some((card) => !card || card.status !== "active")) {
        const error = new Error("The shared support guide has changed.");
        error.code = "grant_stale";
        throw error;
      }
      return {
        schemaVersion: 1,
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        updatedAt: selected.reduce(
          (latest, card) => (card.updatedAt > latest ? card.updatedAt : latest),
          selected[0].updatedAt
        ),
        cards: selected.map(({ cardId, title, statement, category, updatedAt }) => ({
          cardId,
          title,
          statement,
          category,
          updatedAt,
        })),
      };
    }

    return {
      notes: REPLAY_NOTES.map((note) => ({
        ...note,
        revision: replayRevision(`${note.memoryId}:${note.content}`),
      })),
      async listCards() {
        return {
          cards: cards
            .filter((card) => card.status === "pending_review" || card.status === "active")
            .map((card) => ({ ...card })),
        };
      },
      async createManualDraft(input) {
        const card = makeCard(input);
        cards = [...cards, card];
        return { card: { ...card } };
      },
      async generateDrafts(input) {
        if (input.consent !== true) throw new Error("Consent is required.");
        const created = REPLAY_DRAFTS.map((draft) => makeCard(draft));
        cards = [...cards, ...created];
        return { cards: created.map((card) => ({ ...card })) };
      },
      async replaceCard(cardId, input) {
        const prior = cards.find((card) => card.cardId === cardId && card.revision === input.expectedRevision);
        if (!prior) throw new Error("The support card changed after it was loaded.");
        const card = makeCard(input);
        if (prior.status === "active") replacements.set(card.cardId, prior.cardId);
        else prior.status = "rejected";
        cards = [...cards, card];
        return { card: { ...card } };
      },
      async mutateCard(cardId, input, action) {
        const nextStatus = {
          approve: "active",
          reject: "rejected",
          withdraw: "archived",
        }[action];
        if (!nextStatus) throw new Error("The support card action is invalid.");
        const card = cards.find(
          (candidate) => candidate.cardId === cardId && candidate.revision === input.expectedRevision
        );
        if (!card) throw new Error("The support card changed after it was loaded.");
        const expected = action === "withdraw" ? "active" : "pending_review";
        if (card.status !== expected) throw new Error(`The support card must have status ${expected}.`);
        const invalidatedCardIds = [];
        card.status = nextStatus;
        card.updatedAt = now().toISOString();
        card.revision = replayRevision(`${card.cardId}:${card.status}:${card.updatedAt}:${card.statement}`);
        if (action === "withdraw") invalidatedCardIds.push(card.cardId);
        if (action === "approve" && replacements.has(card.cardId)) {
          const prior = cards.find((candidate) => candidate.cardId === replacements.get(card.cardId));
          if (prior) {
            prior.status = "superseded";
            prior.updatedAt = card.updatedAt;
            prior.revision = replayRevision(`${prior.cardId}:${prior.status}:${prior.updatedAt}:${prior.statement}`);
            invalidatedCardIds.push(prior.cardId);
          }
          replacements.delete(card.cardId);
        }
        return { card: { ...card }, invalidatedCardIds };
      },
      seedSharedGuide(grantId, secret, sharedState) {
        if (!hasExactKeys(sharedState, ["grant", "cards"])) {
          throw new Error("The replay share state is invalid.");
        }
        const sharedGrant = assertGrant(sharedState.grant);
        const sharedCards = parseCardList({ cards: sharedState.cards });
        const cardsById = new Map(sharedCards.map((card) => [card.cardId, card]));
        if (
          sharedGrant.grantId !== grantId ||
          sharedCards.length !== sharedGrant.cards.length ||
          sharedGrant.cards.some((reference) => cardsById.get(reference.cardId)?.revision !== reference.revision)
        ) {
          throw new Error("The replay share state is invalid.");
        }
        cards = sharedCards.map((card) => ({ ...card }));
        grants = [{ ...sharedGrant, cards: sharedGrant.cards.map((card) => ({ ...card })) }];
        secrets.set(grantId, secret);
      },
      async exportSharedGuide(grantId, requestId, proof) {
        const grant = grants.find((candidate) => candidate.grantId === grantId);
        const secret = secrets.get(grantId);
        if (!grant || !secret) return { errorCode: "grant_not_found" };
        const expectedProof = await replaySecretProof(secret, requestId, grantId);
        if (!equalReplayProof(expectedProof, proof)) return { errorCode: "grant_not_found" };
        if (grant.status !== "active") return { errorCode: "grant_gone" };
        const selected = grant.cards.map((reference) =>
          cards.find((card) => card.cardId === reference.cardId && card.revision === reference.revision)
        );
        if (selected.some((card) => !card || card.status !== "active")) return { errorCode: "grant_stale" };
        return {
          grant: { ...grant, cards: grant.cards.map((card) => ({ ...card })) },
          cards: selected.map((card) => ({ ...card })),
        };
      },
      async createGrant(input) {
        const selected = input.cardIds.map((cardId) => cards.find((card) => card.cardId === cardId));
        const revisions = new Map(input.cardRevisions.map((card) => [card.cardId, card.revision]));
        if (
          revisions.size !== input.cardIds.length ||
          selected.some((card) => !card || card.status !== "active" || revisions.get(card.cardId) !== card.revision)
        )
          throw new Error("Only approved support cards can be shared.");
        if (!globalScope.crypto?.randomUUID) {
          throw new Error("Synthetic replay needs a secure browser context.");
        }
        const grantId = globalScope.crypto.randomUUID();
        const secret = replayId("replay-secret").padEnd(43, "x");
        const expiresAt = input.expiresAt ?? new Date(now().getTime() + input.durationMs).toISOString();
        const grant = {
          grantId,
          stateVersion: 1,
          cards: input.cardRevisions.map((card) => ({ ...card })),
          createdAt: now().toISOString(),
          expiresAt,
          status: "active",
        };
        grants = [grant, ...grants];
        secrets.set(grantId, secret);
        return { grantId, secret, expiresAt: grant.expiresAt, version: grant.stateVersion };
      },
      async listGrants() {
        return { grants: grants.map((grant) => ({ ...grant, cards: grant.cards.map((card) => ({ ...card })) })) };
      },
      async revokeGrant(grantId, input) {
        const grant = grants.find(
          (candidate) => candidate.grantId === grantId && candidate.stateVersion === input.expectedVersion
        );
        if (!grant) throw new Error("The share link changed after it was loaded.");
        grant.status = "revoked";
        grant.revokedAt = now().toISOString();
        grant.stateVersion += 1;
        return { grantId, revokedAt: grant.revokedAt, version: grant.stateVersion };
      },
      async readGrant(grantId, secret) {
        const grant = grants.find((candidate) => candidate.grantId === grantId);
        if (!grant || secrets.get(grantId) !== secret) {
          const error = new Error("The share link was not found.");
          error.code = "grant_not_found";
          throw error;
        }
        if (grant.status !== "active") {
          const error = new Error("The share link is no longer active.");
          error.code = "grant_gone";
          throw error;
        }
        if (Date.parse(grant.expiresAt) <= now().getTime()) {
          const error = new Error("The share link has expired.");
          error.code = "grant_expired";
          throw error;
        }
        return publicGuide(grant);
      },
      async askGrant(grantId, secret, question) {
        const guide = await this.readGrant(grantId, secret);
        const transitionCard = guide.cards.find(
          (card) =>
            card.category === "transitions" &&
            hasMatchingTransitionIntent(`${card.title} ${card.statement}`, question)
        );
        if (transitionCard) {
          return {
            answer: transitionCard.statement,
            citedCardIds: [transitionCard.cardId],
            coverage: "grounded",
          };
        }
        const quietCard = guide.cards.find(
          (card) =>
            (card.category === "communication" || card.category === "regulation") &&
            /\b(?:stop(?:s|ped|ping)? speaking|quiet (?:place|space|room)|overwhelm(?:ed|ing)?|shut(?:s|ting)? down|settle(?:s|d|ing)?)\b/i.test(
              `${card.title} ${card.statement}`
            )
        );
        if (
          !quietCard ||
          !/\b(?:overwhelm(?:ed|ing)?|stop(?:s|ped|ping)? speaking|quiet|shut(?:s|ting)? down|settle(?:s|d|ing)?)\b/i.test(
            question
          )
        ) {
          return {
            answer: "That is not covered in this person's support guide.",
            citedCardIds: [],
            coverage: "not_in_guide",
          };
        }
        return {
          answer: quietCard.statement,
          citedCardIds: [quietCard.cardId],
          coverage: "grounded",
        };
      },
    };
  }

  globalScope.WhatHelpsMeModel = Object.freeze({
    CARD_CATEGORIES,
    CATEGORY_LABELS,
    LOCK_STATES,
    REPLAY_NOTES,
    buildShareUrl,
    createReplayStore,
    expiryForChoice,
    formatDate,
    groupCards,
    lockState,
    parseAnswer,
    parseCardList,
    parseCreatedGrant,
    parseGrantList,
    parseMemoryPreview,
    parsePublicGuide,
    parseSecret,
    replaySecretProof,
  });
})(window);
