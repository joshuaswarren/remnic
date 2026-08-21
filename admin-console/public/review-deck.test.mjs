/**
 * Review deck state-machine tests (issue #2351).
 *
 * Drives `review-deck.js` directly with fake transports, a fake storage, and a
 * fake clock — no browser, no DOM, no network. Fixtures mirror the real
 * `GET /remnic/v1/review/deck` payload: opaque string revisions, `reviewReason`
 * / `reviewReasonLabel`, `supportCount`, and `provenance` entries.
 *
 * Run it with: node admin-console/public/review-deck.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "review-deck.js")).href);
const {
  createReviewDeck,
  DEPTH_LIMIT,
  ENTRY_LINE,
  ENTRY_TITLE,
  ENTRY_UNKNOWN_HINT,
  REDUCED_MOTION_MS,
} = globalThis.RemnicReviewDeck;

/** Storage stub that records every write so the privacy test can inspect them. */
function createStorageStub(seed = null) {
  const values = new Map();
  const writes = [];
  if (seed) for (const [key, value] of Object.entries(seed)) values.set(key, value);
  return {
    writes,
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
      writes.push({ key, value });
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function item(id, overrides = {}) {
  return {
    schemaVersion: 1,
    itemId: id,
    source: "review",
    sourceId: id,
    memoryId: id,
    content: `Memory content for ${id}`,
    reviewReason: "low_confidence",
    reviewReasonLabel: "Low confidence",
    supportCount: 2,
    provenance: [
      { relation: "supports", excerpt: "Mentioned once in April.", sourceDate: "2026-04-02" },
      { relation: "conflicts", excerpt: "Contradicted in May.", sourceDate: "2026-05-11" },
    ],
    allowedChoices: ["keep", "prepare_fix", "not_true"],
    choiceRisk: { keep: "reversible", prepare_fix: "reversible", not_true: "reversible" },
    namespace: "work/private-namespace",
    revision: `rv1:${id}-a`,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    receiptId: "rcpt-1",
    itemId: "item-1",
    action: "keep",
    outcome: "applied",
    effect: "Remnic keeps using this in recall.",
    undoAvailable: false,
    appliedRevision: "rv1:item-1-b",
    ...overrides,
  };
}

/** Records every transport call; per-call behaviour is supplied by the test. */
function createTransport({ list, action, undo, applyCorrection } = {}) {
  const calls = { list: [], action: [], undo: [], applyCorrection: [] };
  return {
    calls,
    list(request) {
      calls.list.push(request);
      return Promise.resolve(
        list ? list(request, calls.list.length) : { schemaVersion: 1, items: [], total: 0 },
      );
    },
    action(request) {
      calls.action.push(request);
      return Promise.resolve(
        action ? action(request, calls.action.length) : receipt({ itemId: request.itemId }),
      );
    },
    undo(request) {
      calls.undo.push(request);
      return Promise.resolve(undo ? undo(request) : receipt({ action: "undo", outcome: "applied" }));
    },
    applyCorrection(request) {
      calls.applyCorrection.push(request);
      return Promise.resolve(applyCorrection ? applyCorrection(request) : { applied: true });
    },
  };
}

function createClock(startMs = 1_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function deckWith(items, transportOptions = {}, deckOptions = {}) {
  const transport = createTransport({
    list: () => ({ schemaVersion: 1, items, total: items.length }),
    ...transportOptions,
  });
  const storage = deckOptions.storage || createStorageStub();
  const clock = deckOptions.clock || createClock();
  const deck = createReviewDeck({
    transport,
    storage,
    now: clock.now,
    newIdempotencyKey: (action) => `key-${action}-${transport.calls.action.length + 1}`,
    ...deckOptions,
  });
  return { deck, transport, storage, clock };
}

test("entry card appears only for a non-empty queue", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2")]);

  const state = await deck.load();

  assert.equal(state.phase, "ready");
  assert.equal(state.entryCard.title, ENTRY_TITLE);
  assert.equal(state.entryCard.line, ENTRY_LINE);
  assert.equal(state.entryCard.count, 2);
  assert.equal(state.entryCard.countLabel, "2 memories to confirm");
});

test("entry card is hidden for an empty queue", async () => {
  const { deck } = deckWith([]);

  const state = await deck.load();

  assert.equal(state.phase, "empty");
  assert.equal(state.entryCard, null);
});

test("an open deck that refreshes to nothing shows the empty state instead of closing", async () => {
  let items = [item("item-1"), item("item-2")];
  const { deck } = deckWith([], { list: () => ({ schemaVersion: 1, items, total: items.length }) });

  await deck.load();
  deck.openDeck();
  items = [];
  const state = await deck.load();

  assert.equal(state.phase, "empty");
  assert.equal(state.deckOpen, true, "the operator has to see why the deck is empty");
  assert.equal(state.active, null);
  assert.equal(state.entryCard, null);
  assert.equal(state.focusTarget, "close");
});
test("entry card never appears when the deck endpoint returns 404", async () => {
  const gateError = Object.assign(new Error("HTTP 404"), { status: 404 });
  const { deck } = deckWith([], {
    list: () => {
      throw gateError;
    },
  });

  const state = await deck.load();

  assert.equal(state.gated, true);
  assert.equal(state.phase, "gated");
  assert.equal(state.entryCard, null);
  assert.equal(state.listError, null, "a feature gate must not surface an error");
  assert.equal(state.deckOpen, false);

  // Opening the deck while gated must stay a no-op.
  assert.equal(deck.openDeck().deckOpen, false);
});

test("entry card shows a quick-review hint before any local history exists", async () => {
  const { deck } = deckWith([item("item-1")]);

  const state = await deck.load();

  assert.equal(state.entryCard.timeHint, ENTRY_UNKNOWN_HINT);
  assert.equal(state.entryCard.estimated, false, "no fabricated estimate without history");
});

test("entry card estimates from the stored rolling median once history exists", async () => {
  const storage = createStorageStub({
    "remnic.reviewDeck.metrics": JSON.stringify({
      v: 1,
      durationsMs: [20_000, 30_000, 40_000],
      reviewedTotal: 3,
      sessions: 1,
    }),
  });
  const { deck } = deckWith(
    [item("item-1"), item("item-2"), item("item-3"), item("item-4")],
    {},
    { storage },
  );

  const state = await deck.load();

  assert.equal(state.entryCard.estimated, true);
  assert.equal(state.entryCard.timeHint, "About 2 minutes");
});

test("open deck shows one active card and exactly two quiet depth cards", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2"), item("item-3"), item("item-4")]);
  await deck.load();

  const state = deck.openDeck();

  assert.equal(state.phase, "reviewing");
  assert.equal(state.active.itemId, "item-1");
  assert.equal(state.active.reasonLabel, "Low confidence");
  assert.equal(state.active.sourceLabel, "2 sources");
  assert.match(state.active.explanation, /not confident enough/);
  assert.equal(state.active.effects.keep, "Remnic keeps using this in recall.");
  assert.equal(state.depthLimit, DEPTH_LIMIT);
  assert.equal(state.depth.length, 2);
  assert.deepEqual(
    state.depth.map((card) => card.key),
    ["item-2", "item-3"],
  );
  for (const card of state.depth) {
    assert.equal("content" in card, false, "depth cards stay quiet — no memory content");
  }
  assert.equal(state.progress.label, "1/4");
});

test("the action request echoes the opaque revision token verbatim", async () => {
  const { deck, transport } = deckWith([item("item-1", { revision: "rv1:deadbeef" })]);
  await deck.load();
  deck.openDeck();

  await deck.keep();

  assert.deepEqual(transport.calls.action, [
    {
      schemaVersion: 1,
      itemId: "item-1",
      revision: "rv1:deadbeef",
      action: "keep",
      idempotencyKey: "key-keep-1",
    },
  ]);
});

test("a choice the server does not allow is disabled and refused", async () => {
  const { deck, transport } = deckWith([
    item("item-1", { allowedChoices: ["keep", "not_true"] }),
    item("item-2"),
  ]);
  await deck.load();
  const state = deck.openDeck();

  const byAction = Object.fromEntries(state.actions.map((entry) => [entry.action, entry]));
  assert.equal(byAction.fix.disabled, true);
  assert.equal(byAction.keep.disabled, false);
  assert.equal(deck.startFix().reason, "not-allowed");
  assert.equal(transport.calls.action.length, 0);
});

test("Later issues no request and requeues the card at the end", async () => {
  const { deck, transport } = deckWith([item("item-1"), item("item-2"), item("item-3")]);
  await deck.load();
  deck.openDeck();

  const state = deck.later().state;

  assert.equal(transport.calls.action.length, 0, "Later must not call the action endpoint");
  assert.equal(transport.calls.undo.length, 0);
  assert.equal(state.active.itemId, "item-2");
  assert.deepEqual(
    state.depth.map((card) => card.key),
    ["item-3", "item-1"],
    "the deferred card moves to the end of the session queue",
  );
  assert.equal(state.summary, null);
});

test("a failed action restores the same card, keeps focus intent, and does not advance progress", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2"), item("item-3")], {
    action: () => {
      throw new Error("HTTP 500");
    },
  });
  await deck.load();
  deck.openDeck();
  const before = deck.getState();

  const result = await deck.keep();
  const state = result.state;

  assert.equal(result.ok, false);
  assert.equal(state.active.itemId, "item-1", "the same card stays open");
  assert.equal(state.progress.label, before.progress.label, "progress must not advance");
  assert.equal(state.progress.completed, 0);
  assert.equal(state.failure.retryable, true);
  assert.equal(state.failure.focusTarget, "action:keep");
  assert.equal(state.focusTarget, "action:keep", "focus intent returns to the button that failed");
  assert.equal(state.pending, null);
  assert.equal(state.summary, null);
});

test("retry reuses the same idempotency key and advances only once it succeeds", async () => {
  let attempts = 0;
  const { deck, transport } = deckWith([item("item-1"), item("item-2")], {
    action: (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 503");
      return receipt({ itemId: request.itemId, outcome: "applied" });
    },
  });
  await deck.load();
  deck.openDeck();
  await deck.keep();

  const state = (await deck.retry()).state;

  assert.equal(transport.calls.action.length, 2);
  assert.equal(
    transport.calls.action[0].idempotencyKey,
    transport.calls.action[1].idempotencyKey,
    "a retry must not double-apply",
  );
  assert.equal(state.failure, null);
  assert.equal(state.active.itemId, "item-2");
  assert.equal(state.progress.completed, 1);
});

test("the pending overlay leaves the card in place and blocks a second action", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { deck } = deckWith([item("item-1"), item("item-2")], {
    action: async (request) => {
      await gate;
      return receipt({ itemId: request.itemId });
    },
  });
  await deck.load();
  deck.openDeck();

  const inFlight = deck.keep();
  const pendingState = deck.getState();

  assert.deepEqual(
    { action: pendingState.pending.action, itemId: pendingState.pending.itemId },
    { action: "keep", itemId: "item-1" },
  );
  assert.equal(
    pendingState.active.itemId,
    "item-1",
    "the card must not move while a request is in flight",
  );
  assert.equal(
    pendingState.actions.every((entry) => entry.disabled),
    true,
  );
  assert.deepEqual(await deck.notTrue(), {
    ok: false,
    reason: "pending",
    state: pendingState,
  });

  release();
  const state = (await inFlight).state;
  assert.equal(state.pending, null);
  assert.equal(state.active.itemId, "item-2");
});

test("a conflict outcome refreshes only that card and keeps the rest of the queue", async () => {
  const fresh = item("item-1", { revision: "rv1:item-1-fresh", content: "Corrected content" });
  const { deck, transport } = deckWith([item("item-1"), item("item-2"), item("item-3")], {
    list: (_request, callNumber) =>
      callNumber === 1
        ? { schemaVersion: 1, items: [item("item-1"), item("item-2"), item("item-3")], total: 3 }
        : { schemaVersion: 1, items: [fresh, item("item-2"), item("item-3")], total: 3 },
    action: () => receipt({ outcome: "conflict", undoAvailable: false }),
  });
  await deck.load();
  deck.openDeck();

  const result = await deck.keep();
  const state = result.state;

  assert.equal(result.reason, "conflict");
  assert.equal(transport.calls.list.length, 2, "the conflict refresh re-reads the deck once");
  assert.equal(state.active.itemId, "item-1");
  assert.equal(state.active.revision, "rv1:item-1-fresh", "the card gets the newest revision");
  assert.equal(state.active.content, "Corrected content");
  assert.equal(state.active.refreshed, true);
  assert.deepEqual(
    state.depth.map((card) => card.key),
    ["item-2", "item-3"],
    "the remaining cards survive the refresh",
  );
  assert.equal(state.progress.completed, 0, "a conflict does not count as reviewed");
  assert.equal(state.undo, null);
});

test("an explicitly empty appliedRevision is echoed back verbatim as expectedRevision", async () => {
  // A dismissed item has no queue row left, so the server reports appliedRevision
  // as "". That empty string is the value to send back, not a missing one.
  const { deck, transport } = deckWith([item("item-1", { revision: "rv1:stale" }), item("item-2")], {
    action: () =>
      receipt({
        receiptId: "rcpt-dismiss",
        action: "not_true",
        undoAvailable: true,
        appliedRevision: "",
      }),
  });
  await deck.load();
  deck.openDeck();
  await deck.notTrue();

  assert.equal(deck.getState().undo.available, true);
  await deck.undo();

  assert.equal(transport.calls.undo.length, 1);
  assert.equal(
    transport.calls.undo[0].expectedRevision,
    "",
    "an empty appliedRevision must not be replaced with the stale pre-action revision",
  );
});

test("a receipt with no appliedRevision falls back to the item revision", async () => {
  const { deck, transport } = deckWith([item("item-1", { revision: "rv1:current" }), item("item-2")], {
    action: () => {
      const value = receipt({ receiptId: "rcpt-nofield", undoAvailable: true });
      delete value.appliedRevision;
      return value;
    },
  });
  await deck.load();
  deck.openDeck();
  await deck.keep();
  await deck.undo();

  assert.equal(transport.calls.undo[0].expectedRevision, "rv1:current");
});

test("Undo is offered only for a receipt with undoAvailable true", async () => {
  const withoutUndo = deckWith([item("item-1"), item("item-2")], {
    action: () => receipt({ undoAvailable: false }),
  });
  await withoutUndo.deck.load();
  withoutUndo.deck.openDeck();
  const noUndoState = (await withoutUndo.deck.keep()).state;

  assert.equal(noUndoState.undo, null, "no Undo affordance without an undoable receipt");
  const refused = await withoutUndo.deck.undo();
  assert.equal(refused.reason, "unavailable");
  assert.equal(withoutUndo.transport.calls.undo.length, 0, "no undo request without a receipt");
  assert.equal(
    withoutUndo.deck.handleKey({ key: "z", ctrlKey: true }).handled,
    false,
    "the undo chord is inert without an undoable receipt",
  );

  const withUndo = deckWith([item("item-1"), item("item-2")], {
    action: () =>
      receipt({ receiptId: "rcpt-9", undoAvailable: true, appliedRevision: "rv1:item-1-b" }),
  });
  await withUndo.deck.load();
  withUndo.deck.openDeck();
  const undoState = (await withUndo.deck.keep()).state;

  assert.equal(undoState.undo.available, true);
  assert.equal(undoState.undo.receiptId, "rcpt-9");
  assert.equal(undoState.undo.label, "Undo Kept");

  const afterUndo = (await withUndo.deck.undo()).state;
  assert.deepEqual(withUndo.transport.calls.undo, [
    {
      schemaVersion: 1,
      receiptId: "rcpt-9",
      expectedRevision: "rv1:item-1-b",
      idempotencyKey: "key-undo-2",
    },
  ]);
  assert.equal(afterUndo.active.itemId, "item-1", "the undone memory comes back to the deck");
  assert.equal(afterUndo.progress.completed, 0);
  assert.equal(afterUndo.undo, null, "an undo cannot itself be undone from the deck");
});

test("Fix prepares a correction and applies it only after an explicit confirm", async () => {
  const { deck, transport } = deckWith([item("item-1"), item("item-2")], {
    action: (request) =>
      request.action === "prepare_fix"
        ? receipt({
            action: "prepare_fix",
            outcome: "planned",
            correctionPlanId: "plan-77",
            correctionPreview: {
              diff: "- lives in Boston\n+ lives in Berlin",
              warnings: ["One other memory mentions Boston."],
            },
            undoAvailable: false,
          })
        : receipt({ itemId: request.itemId }),
  });
  await deck.load();
  deck.openDeck();

  deck.startFix();
  assert.equal(deck.getState().fix.stage, "input");
  const empty = await deck.prepareFix("   ");
  assert.equal(empty.reason, "empty-correction");
  assert.equal(transport.calls.action.length, 0);

  const prepared = (await deck.prepareFix("lives in Berlin")).state;
  assert.equal(transport.calls.action[0].action, "prepare_fix");
  assert.equal(transport.calls.action[0].correctionText, "lives in Berlin");
  assert.equal(prepared.fix.stage, "preview");
  assert.equal(prepared.fix.preview, "- lives in Boston\n+ lives in Berlin");
  assert.deepEqual(prepared.fix.warnings, ["One other memory mentions Boston."]);
  assert.equal(prepared.active.itemId, "item-1", "the card waits for the confirmation");
  assert.equal(transport.calls.applyCorrection.length, 0, "nothing applies without a confirm");

  const applied = (await deck.confirmFix()).state;
  assert.deepEqual(transport.calls.applyCorrection, [{ planId: "plan-77", confirm: true }]);
  assert.equal(applied.fix, null);
  assert.equal(applied.active.itemId, "item-2");
  assert.equal(applied.progress.completed, 1);
});

test("the evidence drawer opens with the active card's provenance and closes again", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2")]);
  await deck.load();
  deck.openDeck();

  const open = deck.openEvidence();
  assert.equal(open.evidence.open, true);
  assert.equal(open.evidence.items.length, 2);
  assert.equal(open.evidence.items[0].label, "Supports this");
  assert.equal(open.evidence.items[1].label, "Conflicts with this");
  assert.equal(open.evidence.items[0].when, "2026-04-02");
  assert.equal(open.focusTarget, "evidence");

  const closed = deck.closeEvidence();
  assert.equal(closed.evidence.open, false);
  assert.deepEqual(closed.evidence.items, []);
});

test("keyboard shortcuts map to the four actions and Escape closes the drawer before the deck", async () => {
  const { deck, transport } = deckWith(
    [item("item-1"), item("item-2"), item("item-3"), item("item-4")],
    { action: (request) => receipt({ itemId: request.itemId, action: request.action }) },
  );
  await deck.load();
  deck.openDeck();

  const right = deck.handleKey({ key: "ArrowRight" });
  assert.equal(right.intent, "keep");
  await right.promise;
  const left = deck.handleKey({ key: "ArrowLeft" });
  assert.equal(left.intent, "not_true");
  await left.promise;
  assert.deepEqual(
    transport.calls.action.map((call) => call.action),
    ["keep", "not_true"],
  );

  assert.equal(deck.handleKey({ key: " " }).intent, "later");
  assert.equal(deck.handleKey({ key: "e" }).intent, "fix");
  assert.equal(deck.getState().fix.stage, "input");
  // Typing inside the correction editor must not trigger card actions.
  assert.equal(deck.handleKey({ key: "ArrowRight" }).handled, false);
  assert.equal(deck.handleKey({ key: "Escape" }).intent, "cancel-fix");

  deck.openEvidence();
  assert.equal(deck.handleKey({ key: "Escape" }).intent, "close-evidence");
  assert.equal(deck.getState().deckOpen, true, "the first Escape closes the drawer, not the deck");
  assert.equal(deck.handleKey({ key: "Escape" }).intent, "close-deck");
  assert.equal(deck.getState().deckOpen, false);
});

test("Cmd+Z and Ctrl+Z trigger undo once a receipt is undoable", async () => {
  const { deck, transport } = deckWith([item("item-1"), item("item-2")], {
    action: () => receipt({ receiptId: "rcpt-3", undoAvailable: true }),
  });
  await deck.load();
  deck.openDeck();
  await deck.keep();

  const chord = deck.handleKey({ key: "z", metaKey: true });
  assert.equal(chord.intent, "undo");
  await chord.promise;

  assert.equal(transport.calls.undo.length, 1);
  assert.equal(transport.calls.undo[0].receiptId, "rcpt-3");
});

test("offline blocks new server actions while Later still works", async () => {
  const { deck, transport } = deckWith([item("item-1"), item("item-2")]);
  await deck.load();
  deck.openDeck();

  const offline = deck.setOnline(false);
  assert.equal(offline.online, false);
  assert.match(offline.offlineNotice, /Offline/);
  assert.equal(
    offline.actions.filter((entry) => entry.action !== "later").every((entry) => entry.disabled),
    true,
  );
  assert.equal((await deck.keep()).reason, "offline");
  assert.equal((await deck.notTrue()).reason, "offline");
  assert.equal(deck.startFix().reason, "offline");
  assert.equal((await deck.undo()).reason, "unavailable");
  assert.equal(transport.calls.action.length, 0);

  const later = deck.later();
  assert.equal(later.ok, true);
  assert.equal(transport.calls.action.length, 0);

  const online = deck.setOnline(true);
  assert.equal(online.online, true);
  assert.equal(online.offlineNotice, null);
});

test("the completion summary counts match the actions taken", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2"), item("item-3"), item("item-4")], {
    action: (request) =>
      request.action === "prepare_fix"
        ? receipt({ outcome: "planned", correctionPlanId: "plan-1", correctionPreview: "diff" })
        : receipt({ itemId: request.itemId, action: request.action }),
  });
  await deck.load();
  deck.openDeck();

  await deck.keep(); // item-1
  await deck.notTrue(); // item-2
  deck.later(); // item-3 → end of queue
  await deck.prepareFix("corrected wording"); // item-4
  const state = (await deck.confirmFix()).state;

  assert.equal(state.phase, "complete");
  assert.equal(state.summary.headline, "Reviewed 3 memories");
  assert.deepEqual(state.summary.counts, { kept: 1, fixed: 1, untrue: 1, later: 1 });
  assert.deepEqual(state.summary.lines, [
    "1 kept",
    "1 fixed",
    "1 marked not true",
    "1 left for later",
  ]);
  const rendered = `${state.summary.headline} ${state.summary.lines.join(" ")}`;
  assert.doesNotMatch(rendered, /score|streak|points|%/i, "the summary stays neutral");
});

test("nothing sensitive is written to browser storage", async () => {
  const storage = createStorageStub();
  const clock = createClock();
  const { deck } = deckWith(
    [item("item-1"), item("item-2")],
    { action: (request) => receipt({ itemId: request.itemId, action: request.action }) },
    { storage, clock, namespace: "work/private-namespace" },
  );
  await deck.load();
  deck.openDeck();
  clock.advance(25_000);
  await deck.keep();
  clock.advance(35_000);
  await deck.notTrue();

  assert.ok(storage.writes.length > 0, "the deck records review durations");
  assert.deepEqual(
    [...new Set(storage.writes.map((write) => write.key))],
    ["remnic.reviewDeck.metrics"],
  );

  const forbidden = [
    "item-1",
    "item-2",
    "Memory content",
    "Mentioned once in April",
    "private-namespace",
    "low_confidence",
    "Low confidence",
    "rcpt-1",
    "rv1:",
  ];
  for (const write of storage.writes) {
    for (const needle of forbidden) {
      assert.equal(
        write.value.includes(needle),
        false,
        `storage must not contain ${needle}: ${write.value}`,
      );
    }
    const parsed = JSON.parse(write.value);
    assert.deepEqual(Object.keys(parsed).sort(), ["durationsMs", "reviewedTotal", "sessions", "v"]);
    assert.equal(
      parsed.durationsMs.every((value) => typeof value === "number"),
      true,
    );
    assert.equal(typeof parsed.reviewedTotal, "number");
    assert.equal(typeof parsed.sessions, "number");
  }

  const stored = JSON.parse(storage.values.get("remnic.reviewDeck.metrics"));
  assert.deepEqual(stored.durationsMs, [25_000, 35_000]);
});

test("reduced motion replaces movement with a 150 ms opacity change", async () => {
  const reduced = deckWith([item("item-1"), item("item-2")], {}, { reducedMotion: true });
  await reduced.deck.load();
  const reducedState = reduced.deck.openDeck();

  assert.deepEqual(reducedState.motion, {
    reduced: true,
    kind: "opacity",
    durationMs: REDUCED_MOTION_MS,
  });
  assert.equal(reducedState.motion.durationMs, 150);

  const animated = deckWith([item("item-1"), item("item-2")]);
  await animated.deck.load();
  const animatedState = animated.deck.openDeck();

  assert.equal(animatedState.motion.reduced, false);
  assert.equal(animatedState.motion.kind, "slide");
});

test("every completed action produces a fresh announcement", async () => {
  const { deck } = deckWith([item("item-1"), item("item-2"), item("item-3")], {
    action: (request) => receipt({ itemId: request.itemId, action: request.action }),
  });
  await deck.load();
  const opened = deck.openDeck();
  assert.match(opened.announcement, /Review started/);

  const kept = (await deck.keep()).state;
  assert.match(kept.announcement, /^Kept\./);
  assert.equal(kept.announcementSeq > opened.announcementSeq, true);

  const deferred = deck.later().state;
  assert.match(deferred.announcement, /Saved for later/);
  assert.equal(deferred.announcementSeq > kept.announcementSeq, true);
});

test("a non-404 list failure surfaces a retryable error instead of a gate", async () => {
  const { deck } = deckWith([], {
    list: () => {
      throw Object.assign(new Error("HTTP 500"), { status: 500 });
    },
  });

  const state = await deck.load();

  assert.equal(state.phase, "error");
  assert.equal(state.gated, false);
  assert.equal(state.entryCard, null);
  assert.equal(state.listError.retryable, true);
});
