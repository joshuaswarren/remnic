/**
 * Memory check-in review deck — state machine (issue #2351).
 *
 * Pure-ish: no DOM, no fetch, no window/document access. Everything that
 * touches the outside world is injected:
 *
 *   transport { list, action, undo, applyCorrection }  — server calls
 *   storage   { getItem, setItem }                     — browser storage
 *   now()                                              — clock
 *
 * `app.js` owns the real transport and all rendering; this module owns the
 * queue, the receipts, the counters, and the view state the renderer paints.
 *
 * Privacy rule: only bounded numbers reach `storage`. Memory content,
 * provenance, source paths, memory ids, and namespace names never do.
 *
 * Loaded three ways: a browser `<script>` tag (window.RemnicReviewDeck), a CJS
 * `require` (module.exports), and an ESM `import` for the node test, which
 * reads the global this IIFE assigns.
 */
(function (globalScope) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const METRICS_KEY = "remnic.reviewDeck.metrics";
  const METRICS_SCHEMA_VERSION = 1;
  /** Rolling window for the review-duration median. */
  const MAX_DURATION_SAMPLES = 20;
  /** No single review is plausibly longer than this; clamp outliers. */
  const MAX_DURATION_MS = 10 * 60 * 1000;
  /** Quiet cards rendered behind the active one. */
  const DEPTH_LIMIT = 2;
  const REDUCED_MOTION_MS = 150;
  const FULL_MOTION_MS = 220;

  const ENTRY_TITLE = "Memory check-in";
  const ENTRY_LINE = "Confirm what Remnic should trust.";
  const ENTRY_UNKNOWN_HINT = "A quick review";

  const RECALL_EFFECTS = Object.freeze({
    keep: "Remnic keeps using this in recall.",
    not_true: "Remnic stops using this in recall.",
    fix: "Remnic uses your correction in recall instead.",
    later: "Nothing changes until you decide.",
  });

  const ACTION_LABELS = Object.freeze({
    keep: "Kept",
    not_true: "Marked not true",
    fix: "Fixed",
  });

  const KEY_HINTS = Object.freeze({
    not_true: "Left arrow",
    later: "Space",
    fix: "E",
    keep: "Right arrow",
  });

  /** Server choice name per action-row entry; `later` never reaches the server. */
  const SERVER_CHOICES = Object.freeze({ not_true: "not_true", fix: "prepare_fix", keep: "keep" });

  /** "Why this is here", keyed by the review reason the deck endpoint sends. */
  const REASON_EXPLANATIONS = Object.freeze({
    low_confidence: "Remnic is not confident enough in this to keep using it without a check.",
    suggestion: "This came out of a conversation and has never been confirmed.",
    tombstone_blocked: "An earlier deletion blocks this, so Remnic stopped trusting it.",
    contradiction: "Another memory says something different.",
    duplicate: "This looks like a duplicate of another memory.",
  });

  const RELATION_LABELS = Object.freeze({
    supports: "Supports this",
    conflicts: "Conflicts with this",
    origin: "Where this came from",
  });

  function isObject(value) {
    return typeof value === "object" && value !== null;
  }

  function text(value, fallback = "") {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  }

  function positiveInt(value, fallback = 0) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  /**
   * Revisions are opaque server tokens (`rv1:<sha256>`): never parsed, never
   * compared, only echoed back on the action and undo requests.
   */
  function revisionToken(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
  }

  function median(numbers) {
    if (numbers.length === 0) return null;
    const sorted = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  /**
   * Time hint for the entry card. Returns null when there is no local review
   * history so the caller can show "A quick review" instead of a guess.
   */
  function formatTimeHint(medianMs, count) {
    if (!Number.isFinite(medianMs) || medianMs <= 0) return null;
    if (!Number.isFinite(count) || count <= 0) return null;
    const totalSeconds = Math.round((medianMs * count) / 1000);
    if (totalSeconds < 60) return "Under a minute";
    const minutes = Math.max(1, Math.round(totalSeconds / 60));
    return minutes === 1 ? "About 1 minute" : `About ${minutes} minutes`;
  }

  /**
   * Numbers-only metrics store. Every read is re-validated because the value
   * lives in user-writable browser storage.
   */
  function createMetricsStore(storage) {
    function read() {
      const empty = { durationsMs: [], reviewedTotal: 0, sessions: 0 };
      if (!storage || typeof storage.getItem !== "function") return empty;
      let raw;
      try {
        raw = storage.getItem(METRICS_KEY);
      } catch {
        return empty;
      }
      if (typeof raw !== "string" || raw.length === 0) return empty;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return empty;
      }
      if (!isObject(parsed)) return empty;
      const durations = Array.isArray(parsed.durationsMs) ? parsed.durationsMs : [];
      return {
        durationsMs: durations
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.min(MAX_DURATION_MS, Math.round(value)))
          .slice(-MAX_DURATION_SAMPLES),
        reviewedTotal: positiveInt(parsed.reviewedTotal, 0),
        sessions: positiveInt(parsed.sessions, 0),
      };
    }

    function write(next) {
      if (!storage || typeof storage.setItem !== "function") return;
      const payload = {
        v: METRICS_SCHEMA_VERSION,
        durationsMs: next.durationsMs.slice(-MAX_DURATION_SAMPLES),
        reviewedTotal: next.reviewedTotal,
        sessions: next.sessions,
      };
      try {
        storage.setItem(METRICS_KEY, JSON.stringify(payload));
      } catch {
        // Private-mode or quota failures must never break a review.
      }
    }

    return {
      read,
      medianDurationMs() {
        return median(read().durationsMs);
      },
      recordDuration(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs <= 0) return;
        const current = read();
        current.durationsMs.push(Math.min(MAX_DURATION_MS, Math.round(durationMs)));
        current.reviewedTotal += 1;
        write(current);
      },
      recordSession() {
        const current = read();
        current.sessions += 1;
        write(current);
      },
    };
  }

  /** `provenance` entries from the deck endpoint, plus older/looser shapes. */
  function normalizeEvidence(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry, index) => {
        if (typeof entry === "string") {
          return { key: `evidence-${index}`, label: entry, detail: "", when: "", relation: "" };
        }
        if (!isObject(entry)) return null;
        const relation = text(entry.relation, "");
        return {
          key: `evidence-${index}`,
          relation,
          label: text(
            entry.label ?? entry.title ?? RELATION_LABELS[relation],
            relation ? relation : "Source",
          ),
          detail: text(entry.excerpt ?? entry.detail ?? entry.text, ""),
          when: text(entry.sourceDate ?? entry.when ?? entry.observedAt, ""),
        };
      })
      .filter((entry) => entry !== null);
  }

  /** `correctionPreview` is typed `unknown` server-side; render whatever came. */
  function previewText(value) {
    if (typeof value === "string") return value.trim();
    if (!isObject(value)) return "";
    const direct = text(value.diff ?? value.diffPreview ?? value.preview ?? value.summary, "");
    if (direct) return direct;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }

  function previewWarnings(value) {
    if (!isObject(value) || !Array.isArray(value.warnings)) return [];
    return value.warnings.map((entry) => text(entry, "")).filter((entry) => entry.length > 0);
  }

  /** Tolerant normalizer — the deck endpoint is owned by another surface. */
  function normalizeItem(raw) {
    if (!isObject(raw)) return null;
    const itemId = text(raw.itemId ?? raw.id, "");
    if (!itemId) return null;
    const evidence = normalizeEvidence(raw.provenance ?? raw.evidence ?? raw.sources);
    const reasonCode = text(raw.reviewReason ?? raw.reasonCode ?? raw.reason, "review");
    const effects = isObject(raw.effects) ? raw.effects : {};
    const sourceCount = positiveInt(
      raw.supportCount ?? raw.sourceCount ?? evidence.length,
      evidence.length,
    );
    const allowed = Array.isArray(raw.allowedChoices)
      ? raw.allowedChoices.filter((choice) => typeof choice === "string")
      : Object.values(SERVER_CHOICES);
    const reasonLabel = text(
      raw.reviewReasonLabel ?? raw.reasonLabel,
      reasonCode.replace(/[_-]+/g, " "),
    );
    const sourceSentence =
      sourceCount === 1 ? "One source backs it up." : `${sourceCount} sources back it up.`;
    return {
      itemId,
      revision: revisionToken(raw.revision),
      reasonCode,
      reasonLabel,
      sourceCount,
      allowedChoices: allowed,
      content: text(raw.content ?? raw.preview, ""),
      explanation: text(
        raw.explanation ?? raw.why,
        `${REASON_EXPLANATIONS[reasonCode] || `Remnic flagged this as: ${reasonLabel}.`} ${sourceSentence}`,
      ),
      evidence,
      effects: {
        keep: text(effects.keep, RECALL_EFFECTS.keep),
        not_true: text(effects.notTrue ?? effects.not_true, RECALL_EFFECTS.not_true),
        fix: text(effects.fix, RECALL_EFFECTS.fix),
        later: text(effects.later, RECALL_EFFECTS.later),
      },
    };
  }

  function normalizeReceipt(raw, fallback) {
    const source = isObject(raw) ? raw : {};
    return {
      receiptId: text(source.receiptId, ""),
      itemId: text(source.itemId, fallback.itemId),
      action: text(source.action, fallback.action),
      outcome: text(source.outcome, "failed"),
      effect: text(source.effect, ""),
      undoAvailable: source.undoAvailable === true,
      // An empty appliedRevision is a real value, not a missing one: a dismissed
      // item has no queue row left to revision. Presence is tracked separately so
      // the server's "" is echoed back instead of a stale pre-action token.
      appliedRevision: revisionToken(source.appliedRevision),
      appliedRevisionProvided:
        typeof source.appliedRevision === "string" ||
        (typeof source.appliedRevision === "number" &&
          Number.isFinite(source.appliedRevision)),
      correctionPlanId: text(source.correctionPlanId, ""),
      correctionPreview: previewText(source.correctionPreview),
      correctionWarnings: previewWarnings(source.correctionPreview),
    };
  }

  /** A 404 from the deck list means the feature gate is off, not an error. */
  function isFeatureGateError(error) {
    if (!isObject(error)) return false;
    if (error.status === 404 || error.statusCode === 404) return true;
    return /\b404\b/.test(String(error.message || ""));
  }

  function defaultKeyFactory() {
    let counter = 0;
    return function nextKey(action) {
      counter += 1;
      const salt = Math.random().toString(36).slice(2, 10);
      return `deck-${action}-${counter}-${salt}`;
    };
  }

  function createReviewDeck(options = {}) {
    const transport = options.transport || {};
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const metrics = createMetricsStore(options.storage);
    const nextIdempotencyKey =
      typeof options.newIdempotencyKey === "function"
        ? options.newIdempotencyKey
        : defaultKeyFactory();
    const limit = positiveInt(options.limit, 12) || 12;
    const namespace = typeof options.namespace === "string" ? options.namespace : "";
    const listeners = new Set();

    const internal = {
      phase: "idle",
      gated: false,
      online: options.online !== false,
      reducedMotion: options.reducedMotion === true,
      queue: [],
      total: 0,
      nextCursor: null,
      resolvedIds: new Set(),
      deferredIds: new Set(),
      counts: { kept: 0, fixed: 0, untrue: 0 },
      pending: null,
      failure: null,
      conflictItemId: null,
      evidenceOpen: false,
      deckOpen: false,
      fix: null,
      undoReceipt: null,
      announcement: "",
      announcementSeq: 0,
      focusTarget: "deck",
      listError: null,
      cardShownAt: null,
      medianDurationMs: metrics.medianDurationMs(),
      snapshot: null,
    };

    function activeItem() {
      return internal.queue.length > 0 ? internal.queue[0] : null;
    }

    /** Distinct items already dealt with this session — resolved or deferred. */
    function seenCount() {
      return internal.resolvedIds.size + internal.deferredIds.size;
    }

    function progress() {
      const total = Math.max(internal.total, internal.resolvedIds.size);
      const position = total === 0 ? 0 : Math.min(seenCount() + 1, total);
      return {
        position,
        total,
        completed: internal.resolvedIds.size,
        label: `${position}/${total}`,
      };
    }

    function motion() {
      return internal.reducedMotion
        ? { reduced: true, kind: "opacity", durationMs: REDUCED_MOTION_MS }
        : { reduced: false, kind: "slide", durationMs: FULL_MOTION_MS };
    }

    function summary() {
      const { kept, fixed, untrue } = internal.counts;
      const reviewed = kept + fixed + untrue;
      const later = internal.deferredIds.size;
      const lines = [`${kept} kept`, `${fixed} fixed`, `${untrue} marked not true`];
      if (later > 0) lines.push(`${later} left for later`);
      return {
        headline: `Reviewed ${reviewed} ${reviewed === 1 ? "memory" : "memories"}`,
        reviewed,
        counts: { kept, fixed, untrue, later },
        lines,
      };
    }

    function entryCard() {
      if (internal.gated) return null;
      if (internal.total <= 0 || internal.queue.length === 0) return null;
      const hint = formatTimeHint(internal.medianDurationMs, internal.total);
      return {
        title: ENTRY_TITLE,
        line: ENTRY_LINE,
        count: internal.total,
        countLabel: `${internal.total} ${internal.total === 1 ? "memory" : "memories"} to confirm`,
        timeHint: hint || ENTRY_UNKNOWN_HINT,
        estimated: hint !== null,
      };
    }

    function depthCards() {
      return internal.queue.slice(1, 1 + DEPTH_LIMIT).map((item, index) => ({
        key: item.itemId,
        depth: index + 1,
        reasonLabel: item.reasonLabel,
      }));
    }

    function activeView() {
      const item = activeItem();
      if (!item) return null;
      return {
        itemId: item.itemId,
        revision: item.revision,
        reasonCode: item.reasonCode,
        reasonLabel: item.reasonLabel,
        sourceCount: item.sourceCount,
        sourceLabel: `${item.sourceCount} ${item.sourceCount === 1 ? "source" : "sources"}`,
        content: item.content,
        explanation: item.explanation,
        effects: item.effects,
        refreshed: internal.conflictItemId === item.itemId,
      };
    }

    function actionRow() {
      const item = activeItem();
      const blocked = internal.pending !== null || !internal.online;
      const allowed = (action) => {
        if (!item) return false;
        const choice = SERVER_CHOICES[action];
        return !choice || item.allowedChoices.includes(choice);
      };
      return [
        {
          action: "not_true",
          label: "Not true",
          keyHint: KEY_HINTS.not_true,
          disabled: blocked || !allowed("not_true"),
        },
        {
          action: "later",
          label: "Later",
          keyHint: KEY_HINTS.later,
          disabled: internal.pending !== null,
        },
        { action: "fix", label: "Fix", keyHint: KEY_HINTS.fix, disabled: blocked || !allowed("fix") },
        {
          action: "keep",
          label: "Keep",
          keyHint: KEY_HINTS.keep,
          disabled: blocked || !allowed("keep"),
        },
      ];
    }

    function buildSnapshot() {
      const item = activeItem();
      return {
        schemaVersion: SCHEMA_VERSION,
        phase: internal.phase,
        gated: internal.gated,
        online: internal.online,
        deckOpen: internal.deckOpen,
        entryCard: entryCard(),
        active: activeView(),
        depth: depthCards(),
        depthLimit: DEPTH_LIMIT,
        progress: progress(),
        pending: internal.pending ? { ...internal.pending } : null,
        failure: internal.failure ? { ...internal.failure } : null,
        evidence: {
          open: internal.evidenceOpen,
          items: internal.evidenceOpen && item ? item.evidence.slice() : [],
        },
        fix: internal.fix ? { ...internal.fix } : null,
        undo: internal.undoReceipt
          ? {
              available: true,
              receiptId: internal.undoReceipt.receiptId,
              action: internal.undoReceipt.action,
              label: `Undo ${ACTION_LABELS[internal.undoReceipt.action] || internal.undoReceipt.action}`,
            }
          : null,
        actions: actionRow(),
        listError: internal.listError ? { ...internal.listError } : null,
        offlineNotice: internal.online
          ? null
          : "Offline. Decisions are not recorded until the connection returns; Later still works.",
        summary: internal.phase === "complete" ? summary() : null,
        motion: motion(),
        announcement: internal.announcement,
        announcementSeq: internal.announcementSeq,
        focusTarget: internal.focusTarget,
      };
    }

    function emit() {
      internal.snapshot = buildSnapshot();
      listeners.forEach((listener) => {
        try {
          listener(internal.snapshot);
        } catch {
          // A broken renderer must not corrupt deck state.
        }
      });
      return internal.snapshot;
    }

    function announce(message) {
      internal.announcement = message;
      internal.announcementSeq += 1;
    }

    function startCardTimer() {
      internal.cardShownAt = now();
    }

    function recordCardDuration() {
      if (internal.cardShownAt === null) return;
      const elapsed = now() - internal.cardShownAt;
      internal.cardShownAt = null;
      if (elapsed > 0) {
        metrics.recordDuration(elapsed);
        internal.medianDurationMs = metrics.medianDurationMs();
      }
    }

    /**
     * Every remaining card has already been deferred once, so another pass
     * would only re-ask the same questions: end the session instead.
     */
    function everyRemainingDeferred() {
      return (
        internal.queue.length > 0 &&
        internal.queue.every((item) => internal.deferredIds.has(item.itemId))
      );
    }

    function settleQueue() {
      internal.conflictItemId = null;
      internal.evidenceOpen = false;
      internal.fix = null;
      if (internal.queue.length === 0 || everyRemainingDeferred()) {
        internal.phase = "complete";
        internal.focusTarget = "summary";
        internal.cardShownAt = null;
        return;
      }
      internal.phase = "reviewing";
      internal.focusTarget = "card";
      startCardTimer();
    }

    async function load() {
      internal.phase = "loading";
      internal.listError = null;
      internal.gated = false;
      emit();
      let response;
      try {
        response = await transport.list({ namespace, cursor: "", limit });
      } catch (error) {
        if (isFeatureGateError(error)) {
          internal.gated = true;
          internal.phase = "gated";
          internal.queue = [];
          internal.total = 0;
          internal.deckOpen = false;
          return emit();
        }
        internal.phase = "error";
        internal.listError = {
          message: text(error && error.message, "Could not load the review deck."),
          retryable: true,
        };
        return emit();
      }
      const items = Array.isArray(response?.items) ? response.items : [];
      internal.queue = items.map(normalizeItem).filter((item) => item !== null);
      internal.total = positiveInt(response?.total, internal.queue.length) || internal.queue.length;
      internal.nextCursor = text(response?.nextCursor, "") || null;
      internal.resolvedIds = new Set();
      internal.deferredIds = new Set();
      internal.counts = { kept: 0, fixed: 0, untrue: 0 };
      internal.undoReceipt = null;
      internal.failure = null;
      internal.pending = null;
      internal.medianDurationMs = metrics.medianDurationMs();
      if (internal.queue.length === 0) {
        internal.total = 0;
        internal.phase = "empty";
        // An open deck stays open so the operator reads the empty state instead
        // of having the panel vanish from under them.
        internal.focusTarget = internal.deckOpen ? "close" : "entry";
        return emit();
      }
      internal.phase = "ready";
      return emit();
    }

    function openDeck() {
      if (internal.gated || internal.queue.length === 0) return emit();
      internal.deckOpen = true;
      metrics.recordSession();
      settleQueue();
      announce(`Review started. ${progress().label}.`);
      return emit();
    }

    function closeDeck() {
      internal.deckOpen = false;
      internal.evidenceOpen = false;
      internal.fix = null;
      internal.cardShownAt = null;
      internal.focusTarget = "entry";
      return emit();
    }

    function openEvidence() {
      if (!activeItem()) return emit();
      internal.evidenceOpen = true;
      internal.focusTarget = "evidence";
      return emit();
    }

    function closeEvidence() {
      internal.evidenceOpen = false;
      internal.focusTarget = "card";
      return emit();
    }

    function guard(action) {
      if (internal.pending) return { ok: false, reason: "pending" };
      const item = activeItem();
      if (!item) return { ok: false, reason: "empty" };
      if (!internal.online && action !== "later") return { ok: false, reason: "offline" };
      const choice = SERVER_CHOICES[action] || (action === "prepare_fix" ? "prepare_fix" : null);
      if (choice && !item.allowedChoices.includes(choice)) {
        return { ok: false, reason: "not-allowed" };
      }
      return { ok: true };
    }

    function rejection(reason) {
      return { ok: false, reason, state: internal.snapshot || buildSnapshot() };
    }

    function applyResolution(item, action) {
      recordCardDuration();
      internal.resolvedIds.add(item.itemId);
      internal.deferredIds.delete(item.itemId);
      internal.queue = internal.queue.filter((candidate) => candidate.itemId !== item.itemId);
      if (action === "keep") internal.counts.kept += 1;
      if (action === "not_true") internal.counts.untrue += 1;
      if (action === "fix") internal.counts.fixed += 1;
      settleQueue();
    }

    /** Replace one card in place after a conflict; the rest of the queue stays. */
    async function refreshConflictedCard(itemId) {
      let response;
      try {
        response = await transport.list({ namespace, cursor: "", limit });
      } catch {
        internal.failure = {
          action: "refresh",
          itemId,
          message: "This memory changed and the newest version could not be loaded. Try again.",
          retryable: true,
          focusTarget: "card",
        };
        return;
      }
      const items = Array.isArray(response?.items) ? response.items : [];
      const fresh = items.map(normalizeItem).find((item) => item && item.itemId === itemId) || null;
      const index = internal.queue.findIndex((item) => item.itemId === itemId);
      if (index === -1) return;
      if (fresh) {
        internal.queue[index] = fresh;
        internal.conflictItemId = itemId;
        announce("This memory changed. Showing the newest version.");
        return;
      }
      internal.queue.splice(index, 1);
      internal.deferredIds.delete(itemId);
      announce("This memory is no longer in the queue.");
      if (internal.queue.length === 0 || everyRemainingDeferred()) settleQueue();
    }

    async function submitAction(action, extras = {}, retryKey = null) {
      const check = guard(action);
      if (!check.ok) return rejection(check.reason);
      const item = activeItem();
      const idempotencyKey = retryKey || nextIdempotencyKey(action);
      const focusTarget = `action:${action === "prepare_fix" ? "fix" : action}`;
      internal.pending = { action, itemId: item.itemId, focusTarget };
      internal.failure = null;
      emit();

      let receipt;
      try {
        const raw = await transport.action({
          schemaVersion: SCHEMA_VERSION,
          itemId: item.itemId,
          revision: item.revision,
          action,
          idempotencyKey,
          ...extras,
        });
        receipt = normalizeReceipt(raw, { itemId: item.itemId, action });
      } catch (error) {
        internal.pending = null;
        internal.failure = {
          action,
          itemId: item.itemId,
          idempotencyKey,
          extras,
          message: text(error && error.message, "That did not go through."),
          retryable: true,
          focusTarget,
        };
        internal.focusTarget = focusTarget;
        if (action === "prepare_fix" && internal.fix) {
          internal.fix = { ...internal.fix, stage: "input" };
        }
        announce("That did not go through. The same memory is still open.");
        return { ok: false, reason: "failed", state: emit() };
      }

      internal.pending = null;

      if (receipt.outcome === "conflict") {
        await refreshConflictedCard(item.itemId);
        internal.focusTarget = "card";
        if (action === "prepare_fix") internal.fix = null;
        return { ok: false, reason: "conflict", receipt, state: emit() };
      }

      if (receipt.outcome === "failed") {
        internal.failure = {
          action,
          itemId: item.itemId,
          idempotencyKey,
          extras,
          message: text(receipt.effect, "The server refused that action."),
          retryable: true,
          focusTarget,
        };
        internal.focusTarget = focusTarget;
        if (action === "prepare_fix" && internal.fix) {
          internal.fix = { ...internal.fix, stage: "input" };
        }
        announce("That did not go through. The same memory is still open.");
        return { ok: false, reason: "failed", receipt, state: emit() };
      }

      internal.undoReceipt = receipt.undoAvailable
        ? {
            receiptId: receipt.receiptId,
            itemId: item.itemId,
            action,
            appliedRevision: receipt.appliedRevisionProvided
              ? receipt.appliedRevision
              : item.revision,
            item,
          }
        : null;

      if (action === "prepare_fix") {
        internal.fix = {
          stage: "preview",
          text: text(extras.correctionText, ""),
          planId: receipt.correctionPlanId,
          preview: receipt.correctionPreview,
          warnings: receipt.correctionWarnings,
          message: "",
        };
        internal.focusTarget = "fix:confirm";
        announce("Correction prepared. Confirm to apply it.");
        return { ok: true, receipt, state: emit() };
      }

      applyResolution(item, action);
      announce(
        `${ACTION_LABELS[action] || action}. ${text(receipt.effect, item.effects[action] || "")}`.trim(),
      );
      return { ok: true, receipt, state: emit() };
    }

    function keep() {
      return submitAction("keep");
    }

    function notTrue() {
      return submitAction("not_true");
    }

    function later() {
      const check = guard("later");
      if (!check.ok) return rejection(check.reason);
      const item = internal.queue.shift();
      internal.deferredIds.add(item.itemId);
      internal.queue.push(item);
      internal.undoReceipt = null;
      recordCardDuration();
      settleQueue();
      announce("Saved for later. Nothing changed.");
      return { ok: true, state: emit() };
    }

    function startFix() {
      const check = guard("fix");
      if (!check.ok) return rejection(check.reason);
      internal.fix = { stage: "input", text: "", planId: "", preview: "", warnings: [], message: "" };
      internal.focusTarget = "fix:input";
      return { ok: true, state: emit() };
    }

    function setFixText(value) {
      if (!internal.fix) return emit();
      internal.fix = { ...internal.fix, text: typeof value === "string" ? value : "" };
      return emit();
    }

    function cancelFix() {
      internal.fix = null;
      internal.focusTarget = "card";
      return emit();
    }

    function prepareFix(correctionText) {
      const value = text(correctionText, internal.fix ? internal.fix.text : "");
      if (!value) {
        internal.fix = {
          stage: "input",
          text: "",
          planId: "",
          preview: "",
          warnings: [],
          message: "Type the correction first.",
        };
        internal.focusTarget = "fix:input";
        return Promise.resolve({ ok: false, reason: "empty-correction", state: emit() });
      }
      internal.fix = {
        stage: "preparing",
        text: value,
        planId: "",
        preview: "",
        warnings: [],
        message: "",
      };
      return submitAction("prepare_fix", { correctionText: value });
    }

    async function confirmFix() {
      if (!internal.fix || internal.fix.stage !== "preview") return rejection("no-preview");
      if (!internal.online) return rejection("offline");
      const item = activeItem();
      if (!item) return rejection("empty");
      const planId = internal.fix.planId;
      if (!planId) {
        internal.fix = { ...internal.fix, message: "The server did not return a correction plan." };
        return { ok: false, reason: "no-plan", state: emit() };
      }
      internal.pending = { action: "apply_fix", itemId: item.itemId, focusTarget: "fix:confirm" };
      internal.fix = { ...internal.fix, stage: "applying" };
      emit();
      try {
        await transport.applyCorrection({ planId, confirm: true });
      } catch (error) {
        internal.pending = null;
        internal.fix = { ...internal.fix, stage: "preview" };
        internal.failure = {
          action: "apply_fix",
          itemId: item.itemId,
          message: text(error && error.message, "The correction was not applied."),
          retryable: true,
          focusTarget: "fix:confirm",
        };
        internal.focusTarget = "fix:confirm";
        announce("The correction was not applied. The same memory is still open.");
        return { ok: false, reason: "failed", state: emit() };
      }
      internal.pending = null;
      applyResolution(item, "fix");
      announce(`Fixed. ${item.effects.fix}`);
      return { ok: true, state: emit() };
    }

    async function undo() {
      if (!internal.undoReceipt) return rejection("unavailable");
      if (!internal.online) return rejection("offline");
      if (internal.pending) return rejection("pending");
      const receipt = internal.undoReceipt;
      internal.pending = { action: "undo", itemId: receipt.itemId, focusTarget: "undo" };
      emit();
      let result;
      try {
        result = normalizeReceipt(
          await transport.undo({
            schemaVersion: SCHEMA_VERSION,
            receiptId: receipt.receiptId,
            expectedRevision: receipt.appliedRevision,
            idempotencyKey: nextIdempotencyKey("undo"),
          }),
          { itemId: receipt.itemId, action: "undo" },
        );
      } catch (error) {
        internal.pending = null;
        internal.failure = {
          action: "undo",
          itemId: receipt.itemId,
          message: text(error && error.message, "The undo did not go through."),
          retryable: false,
          focusTarget: "undo",
        };
        internal.focusTarget = "undo";
        return { ok: false, reason: "failed", state: emit() };
      }
      internal.pending = null;
      if (result.outcome === "failed" || result.outcome === "conflict") {
        internal.failure = {
          action: "undo",
          itemId: receipt.itemId,
          message: "This memory changed since that decision, so it cannot be undone here.",
          retryable: false,
          focusTarget: "undo",
        };
        internal.undoReceipt = null;
        internal.focusTarget = "undo";
        return { ok: false, reason: result.outcome, state: emit() };
      }
      if (receipt.action === "keep") internal.counts.kept = Math.max(0, internal.counts.kept - 1);
      if (receipt.action === "not_true") {
        internal.counts.untrue = Math.max(0, internal.counts.untrue - 1);
      }
      if (receipt.action === "fix") internal.counts.fixed = Math.max(0, internal.counts.fixed - 1);
      internal.resolvedIds.delete(receipt.itemId);
      if (!internal.queue.some((item) => item.itemId === receipt.itemId)) {
        internal.queue.unshift(receipt.item);
      }
      internal.undoReceipt = null;
      settleQueue();
      announce("Undone. The memory is back in the deck.");
      return { ok: true, state: emit() };
    }

    function retry() {
      const failure = internal.failure;
      if (!failure || failure.retryable !== true) {
        return Promise.resolve(rejection("nothing-to-retry"));
      }
      internal.failure = null;
      if (failure.action === "apply_fix") {
        internal.fix = internal.fix ? { ...internal.fix, stage: "preview" } : null;
        return confirmFix();
      }
      if (failure.action === "refresh") {
        return refreshConflictedCard(failure.itemId).then(() => ({ ok: true, state: emit() }));
      }
      // Same idempotency key: retrying a request that may have landed must not
      // apply it twice.
      return submitAction(failure.action, failure.extras || {}, failure.idempotencyKey);
    }

    function setOnline(value) {
      const next = value === true;
      if (next === internal.online) return internal.snapshot || buildSnapshot();
      internal.online = next;
      announce(
        next
          ? "Back online. You can keep reviewing."
          : "Offline. Decisions are paused until the connection returns.",
      );
      return emit();
    }

    function handleKey(event) {
      const key = isObject(event) ? event.key : "";
      const undoChord = isObject(event) && (event.ctrlKey === true || event.metaKey === true);
      if (key === "Escape") {
        if (internal.evidenceOpen) {
          return { handled: true, intent: "close-evidence", state: closeEvidence() };
        }
        if (internal.fix) return { handled: true, intent: "cancel-fix", state: cancelFix() };
        if (internal.deckOpen) return { handled: true, intent: "close-deck", state: closeDeck() };
        return { handled: false, intent: null };
      }
      if (!internal.deckOpen) return { handled: false, intent: null };
      if (undoChord && (key === "z" || key === "Z")) {
        if (!internal.undoReceipt) return { handled: false, intent: null };
        return { handled: true, intent: "undo", promise: undo() };
      }
      // While the correction editor is open, typing must reach the input.
      if (internal.fix) return { handled: false, intent: null };
      if (key === "ArrowRight") return { handled: true, intent: "keep", promise: keep() };
      if (key === "ArrowLeft") return { handled: true, intent: "not_true", promise: notTrue() };
      if (key === " " || key === "Spacebar") {
        return { handled: true, intent: "later", state: later().state };
      }
      if (key === "e" || key === "E") return { handled: true, intent: "fix", state: startFix().state };
      return { handled: false, intent: null };
    }

    internal.snapshot = buildSnapshot();

    return {
      subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        listener(internal.snapshot);
        return () => listeners.delete(listener);
      },
      getState() {
        return internal.snapshot;
      },
      load,
      openDeck,
      closeDeck,
      openEvidence,
      closeEvidence,
      keep,
      notTrue,
      later,
      startFix,
      setFixText,
      prepareFix,
      confirmFix,
      cancelFix,
      undo,
      retry,
      setOnline,
      handleKey,
      metrics,
    };
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    METRICS_KEY,
    DEPTH_LIMIT,
    REDUCED_MOTION_MS,
    FULL_MOTION_MS,
    ENTRY_TITLE,
    ENTRY_LINE,
    ENTRY_UNKNOWN_HINT,
    RECALL_EFFECTS,
    KEY_HINTS,
    REASON_EXPLANATIONS,
    createReviewDeck,
    createMetricsStore,
    formatTimeHint,
  });

  globalScope.RemnicReviewDeck = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
