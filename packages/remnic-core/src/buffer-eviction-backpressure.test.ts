import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer, BufferAdmissionRefusedError } from "./buffer.js";
import { parseConfig } from "./config.js";
import { log } from "./logger.js";
import { TurnIngestionCoordinator } from "./orchestration/turn-ingestion.js";
import type { BufferEntryState, BufferState, BufferTurn } from "./types.js";

class FakeStorage {
  public saved: BufferState | null = null;
  public saveCount = 0;

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.saveCount += 1;
    this.saved = structuredClone(state);
  }
}

function makeTurn(key: string, content: string, accepted = false): BufferTurn {
  const turn: BufferTurn = {
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    sessionKey: key,
  };
  if (accepted) turn.acceptedCapture = true;
  return turn;
}

function entry(turns: BufferTurn[]): BufferEntryState {
  return { turns, lastExtractionAt: null, extractionCount: 0 };
}

function emptyEntry(): BufferEntryState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

/** default + the given entries; default stays empty unless given. */
function seededState(entries: Record<string, BufferEntryState>): BufferState {
  const defaultEntry = entries.default ?? emptyEntry();
  return {
    turns: defaultEntry.turns,
    lastExtractionAt: defaultEntry.lastExtractionAt,
    extractionCount: defaultEntry.extractionCount,
    entries: { default: defaultEntry, ...entries },
  };
}

function makeBuffer(state: BufferState, maxSessions: number) {
  const config = parseConfig({ bufferSaveDebounceMs: 0, bufferMaxSessions: maxSessions });
  const storage = new FakeStorage(state);
  const buffer = new SmartBuffer(config, storage);
  return { buffer, storage };
}

const CAP = 4;

function savedKeys(storage: FakeStorage): string[] {
  return Object.keys(storage.saved?.entries ?? {});
}

test("live capture at a cap full of non-empty backlog is refused, never evicts buffered turns", async () => {
  const { buffer } = makeBuffer(
    seededState({
      a: entry([makeTurn("a", "backlog a")]),
      b: entry([makeTurn("b", "backlog b")]),
      c: entry([makeTurn("c", "backlog c")]),
    }),
    CAP,
  );

  await assert.rejects(
    buffer.addTurn("new-session", makeTurn("new-session", "live turn")),
    BufferAdmissionRefusedError,
  );

  assert.deepEqual(buffer.getTurns("a").map((t) => t.content), ["backlog a"], "oldest backlog lost to live admission");
  assert.deepEqual(buffer.getTurns("b").map((t) => t.content), ["backlog b"]);
  assert.deepEqual(buffer.getTurns("c").map((t) => t.content), ["backlog c"]);
  assert.equal(buffer.getTurns("new-session").length, 0, "refused turn was not buffered");

  // Accepted captures are subject to the same no-backlog-loss limit: refusal
  // happens before acceptance, preserving accepted-capture non-eviction.
  assert.equal(
    await buffer.addTurnBounded("accepted-1", makeTurn("accepted-1", "accepted", true)),
    null,
    "accepted capture is refused rather than evicting native backlog",
  );
  assert.deepEqual(buffer.getTurns("a").map((t) => t.content), ["backlog a"]);
  assert.deepEqual(buffer.getTurns("b").map((t) => t.content), ["backlog b"]);
  assert.deepEqual(buffer.getTurns("c").map((t) => t.content), ["backlog c"]);
});

test("an already-admitted session keeps accepting turns at a full cap", async () => {
  const { buffer, storage } = makeBuffer(
    seededState({
      a: entry([makeTurn("a", "backlog a")]),
      b: entry([makeTurn("b", "backlog b")]),
      c: entry([makeTurn("c", "backlog c")]),
    }),
    CAP,
  );

  const decision = await buffer.addTurn("b", makeTurn("b", "another b turn"));
  assert.equal(decision, "keep_buffering");
  assert.deepEqual(buffer.getTurns("b").map((t) => t.content), ["backlog b", "another b turn"]);
  assert.deepEqual(buffer.getTurns("a").map((t) => t.content), ["backlog a"], "existing-session admission must not evict peers");
  assert.deepEqual(buffer.getTurns("c").map((t) => t.content), ["backlog c"]);
  assert.equal(savedKeys(storage).length, CAP, "entry count stays at the cap");
});

test("empty entries are still evicted first to admit a new live session", async () => {
  const { buffer, storage } = makeBuffer(
    seededState({
      "empty-oldest": emptyEntry(),
      n1: entry([makeTurn("n1", "native 1")]),
      n2: entry([makeTurn("n2", "native 2")]),
    }),
    CAP,
  );

  const decision = await buffer.addTurn("new-session", makeTurn("new-session", "live turn"));
  assert.equal(decision, "keep_buffering");
  const keys = savedKeys(storage);
  assert.ok(!keys.includes("empty-oldest"), "oldest empty entry reclaimed");
  assert.ok(keys.includes("new-session"), "new session admitted");
  assert.deepEqual(buffer.getTurns("n1").map((t) => t.content), ["native 1"], "empty eviction must not touch backlog");
  assert.deepEqual(buffer.getTurns("n2").map((t) => t.content), ["native 2"]);
});

test("a retained-only entry is non-evictable backlog: live admission is refused instead", async () => {
  const retainedOnly: BufferEntryState = {
    turns: [],
    retainedTurns: [makeTurn("r", "deferred retry turn")],
    lastExtractionAt: null,
    extractionCount: 0,
  };
  const { buffer } = makeBuffer(
    seededState({
      r: retainedOnly,
      n1: entry([makeTurn("n1", "native 1")]),
      n2: entry([makeTurn("n2", "native 2")]),
    }),
    CAP,
  );

  await assert.rejects(
    buffer.addTurn("new-session", makeTurn("new-session", "live turn")),
    BufferAdmissionRefusedError,
  );
  assert.equal(
    buffer.getRetainedDeferredTurns("r").length,
    1,
    "retained retry turns must not be evicted as 'empty'",
  );
});
test("concurrent multi-session admissions reserve capacity without partial batches", async () => {
  const { buffer } = makeBuffer(seededState({}), 2);
  const results = await Promise.all([
    buffer.addTurnsBounded([{ bufferKey: "batch-a", turns: [makeTurn("batch-a", "a")] }]),
    buffer.addTurnsBounded([{ bufferKey: "batch-b", turns: [makeTurn("batch-b", "b")] }]),
  ]);

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal(buffer.getTurns("batch-a").length + buffer.getTurns("batch-b").length, 1);
});

test("processTurn propagates retryable admission refusal without queueing extraction", async () => {
  const { buffer } = makeBuffer(
    seededState({
      a: entry([makeTurn("a", "backlog a")]),
      b: entry([makeTurn("b", "backlog b")]),
      c: entry([makeTurn("c", "backlog c")]),
    }),
    CAP,
  );
  const config = parseConfig({
    memoryDir: "/tmp/unused-buffer-eviction-backpressure",
    bufferSaveDebounceMs: 0,
    bufferMaxSessions: CAP,
  });
  const queued: BufferTurn[][] = [];
  type CoordinatorDeps = ConstructorParameters<typeof TurnIngestionCoordinator>[0];
  // SAFETY: this fixture exercises only admission + refusal; the remaining
  // coordinator deps are never reached on this path.
  const deps = Object.assign({} as CoordinatorDeps, {
    buffer,
    config,
    queueBufferedExtraction: async (turns: BufferTurn[]) => {
      queued.push(turns);
    },
  });
  const coordinator = new TurnIngestionCoordinator(deps);

  await assert.rejects(
    coordinator.processTurn("user", "live turn", "new-session"),
    BufferAdmissionRefusedError,
    "caller must receive retryable refusal rather than successful acknowledgment",
  );

  assert.equal(queued.length, 0, "a refused turn must not queue extraction");
  assert.equal(buffer.getTurns("new-session").length, 0, "a refused turn must not be buffered");
  assert.deepEqual(buffer.getTurns("a").map((x) => x.content), ["backlog a"], "backlog dropped during refused admission");
});
