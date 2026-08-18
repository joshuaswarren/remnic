/**
 * Admin console Timeline pane — day view state machine (issue #1986).
 *
 * Pure-ish: no DOM, no fetch, no window/document access in the model.
 * Everything that touches the outside world is injected:
 *
 *   transport { getDay(date), enabled() }  — server calls / feature gate
 *   now()                                  — clock
 *
 * `app.js` owns the real transport and calls `renderTimelinePane`.
 * This module owns date navigation and the view state the renderer paints.
 *
 * Loaded three ways: a browser `<script>` tag (window.RemnicTimelinePane),
 * a CJS `require` (module.exports), and an ESM `import` for the node test,
 * which reads the global this IIFE assigns.
 */
(function (globalScope) {
  const EMPTY_STATE = "Timeline is off. Set activity.timeline.enabled to true.";
  const WEEK_HEADING = "Week";
  const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
  const MS_PER_DAY = 86_400_000;
  const MS_PER_MINUTE = 60_000;

  function dateKeyFromNow(now) {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().slice(0, 10);
  }

  function shiftDate(dateKey, deltaDays) {
    const utc = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (!Number.isFinite(utc)) return dateKey;
    return new Date(utc + deltaDays * MS_PER_DAY).toISOString().slice(0, 10);
  }

  function durationMinutes(start, end, fallback) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      return Math.max(0, Math.round((endMs - startMs) / MS_PER_MINUTE));
    }
    return typeof fallback === "number" && Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
  }

  function mapCard(card) {
    if (!card || typeof card !== "object") return null;
    const start = card.start || card.startUtc || "";
    const end = card.end || card.endUtc || "";
    return {
      start,
      end,
      title: typeof card.title === "string" ? card.title : "",
      category: card.category || card.categoryId || "",
      duration: durationMinutes(start, end, card.duration),
    };
  }

  function mapCards(day) {
    const raw = Array.isArray(day) ? day : day && Array.isArray(day.cards) ? day.cards : [];
    const cards = [];
    for (const card of raw) {
      const mapped = mapCard(card);
      if (mapped) cards.push(mapped);
    }
    return cards;
  }

  function createTimelinePane(options = {}) {
    const transport = options.transport || {};
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    let date = dateKeyFromNow(now);
    let cards = [];
    const listeners = [];

    function isEnabled() {
      return typeof transport.enabled === "function" && transport.enabled() === true;
    }

    function getState() {
      if (!isEnabled()) {
        return { emptyState: EMPTY_STATE };
      }
      return { date, cards, weekHeading: WEEK_HEADING };
    }

    function emit() {
      const state = getState();
      for (const listener of listeners) listener(state);
      return state;
    }

    async function load() {
      if (!isEnabled() || typeof transport.getDay !== "function") {
        cards = [];
        return emit();
      }
      try {
        cards = mapCards(await transport.getDay(date));
      } catch {
        cards = [];
      }
      return emit();
    }

    function subscribe(listener) {
      if (typeof listener === "function") listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    function setDate(next) {
      if (typeof next !== "string" || !DATE_KEY.test(next)) return Promise.resolve(getState());
      date = next;
      return load();
    }

    return {
      getState,
      subscribe,
      load,
      setDate,
      prev: () => setDate(shiftDate(date, -1)),
      next: () => setDate(shiftDate(date, 1)),
      today: () => setDate(dateKeyFromNow(now)),
    };
  }

  // Paint helper lives here so app.js stays under its line ratchet.
  function renderTimelinePane(root, state) {
    if (!root || !state) return;
    const doc = root.ownerDocument || globalScope.document;
    if (!doc) return;
    const status = root.querySelector("#timelineStatus");
    const list = root.querySelector("#timelineCards");
    const dateInput = root.querySelector("#timelineDateInput");
    const week = root.querySelector("#timelineWeekHeading");
    const nav = root.querySelector("#timelineNav");
    if (state.emptyState) {
      if (status) status.textContent = state.emptyState;
      if (list) while (list.firstChild) list.removeChild(list.firstChild);
      if (week) week.hidden = true;
      if (nav) nav.hidden = true;
      return;
    }
    if (nav) nav.hidden = false;
    if (week) {
      week.hidden = false;
      week.textContent = state.weekHeading || WEEK_HEADING;
    }
    if (dateInput && dateInput.value !== state.date) dateInput.value = state.date || "";
    if (status) status.textContent = state.date || "";
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const card of state.cards || []) {
      const el = doc.createElement("article");
      el.className = "timeline-card";
      const range = doc.createElement("div");
      range.className = "meta";
      range.textContent = `${card.start} – ${card.end}`;
      const title = doc.createElement("strong");
      title.textContent = card.title;
      const detail = doc.createElement("div");
      detail.className = "status";
      detail.textContent = `${card.category} · ${card.duration} min`;
      el.appendChild(range);
      el.appendChild(title);
      el.appendChild(detail);
      list.appendChild(el);
    }
  }

  const api = Object.freeze({
    EMPTY_STATE,
    WEEK_HEADING,
    createTimelinePane,
    renderTimelinePane,
  });

  globalScope.RemnicTimelinePane = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
