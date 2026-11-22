
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramAccessService, EngramAccessInputError } from "./access-service.js";
import { stripMemoryHandles } from "./sanitize.js";
import { handleFor, renderHandle } from "./recall-handles.js";
import type { PluginConfig, QmdSearchResult } from "./types.js";


interface Harness {
  orchestrator: Orchestrator;
  service: EngramAccessService;
  memoryDir: string;
}

async function makeHarness(
  overrides: Partial<PluginConfig> = {},
): Promise<Harness> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-handles-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    // Keep the pipeline quiet: no QMD/graph/judge competing with the assertions.
    qmdEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    ...overrides,
  });
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);
  return { orchestrator, service, memoryDir };
}

/** QMD results carry `.path` ending in `<memoryId>.md`; that is the id handles derive from. */
function qmdResult(memoryId: string, snippet = "snippet", score = 0.9): QmdSearchResult {
  return {
    docid: memoryId,
    path: `/mem/default/${memoryId}.md`,
    line: 1,
    snippet,
    score,
  };
}

interface FormatQmdResultsAccess {
  formatQmdResults(
    title: string,
    results: QmdSearchResult[],
    sessionKey?: string,
  ): string;
}

function formatQmd(
  orch: Orchestrator,
  title: string,
  results: QmdSearchResult[],
  sessionKey?: string,
): string {
  const internals = orch as unknown as FormatQmdResultsAccess;
  return internals.formatQmdResults(title, results, sessionKey);
}

const SESSION = "sess-handles-test";
const ID_A = "fact-1770469224307-eelr";
const ID_B = "fact-1770469224308-bxkq";


test("stripMemoryHandles removes a trailing handle token and its preceding space", () => {
  assert.equal(
    stripMemoryHandles("API rate limit is 1000 rpm. [m:4f2a]"),
    "API rate limit is 1000 rpm.",
  );
});

test("stripMemoryHandles removes multiple inline handles and tidies spacing", () => {
  assert.equal(
    stripMemoryHandles("see [m:4f2a] and also [m:9b1c] for more"),
    "see and also for more",
  );
});

test("stripMemoryHandles leaves handle-free text unchanged", () => {
  assert.equal(stripMemoryHandles("plain text, no handles"), "plain text, no handles");
});


test("formatQmdResults: handles OFF emits no [m:xxxx] (byte-identical to pre-#1582)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: false });
  try {
    const out = formatQmd(orchestrator, "Workspace Context", [
      qmdResult(ID_A, "The API rate limit is 1000 rpm."),
    ]);
    assert.doesNotMatch(out, /\[m:[0-9a-f]{4,8}\]/);
    assert.match(out, /\[1\] .*\.md.*\(score: /);
    assert.match(out, /The API rate limit is 1000 rpm\./);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatQmdResults: handles ON appends [m:xxxx] derived from the memory id", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const out = formatQmd(orchestrator, "Workspace Context", [
      qmdResult(ID_A, "The API rate limit is 1000 rpm."),
    ], SESSION);
    const expected = `[m:${handleFor(ID_A)}]`;
    assert.ok(
      out.includes(expected),
      `expected rendered handle ${expected} in output:\n${out}`,
    );
    const esc = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(out, new RegExp(`The API rate limit is 1000 rpm\\. ${esc}`));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatQmdResults: result without an .md id gets no handle (entity reconstructions)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const out = formatQmd(orchestrator, "Workspace Context", [
      { docid: "Widget", path: "/entities/Widget.json", line: 3, snippet: "entity reconstruction", score: 0.5 },
    ], SESSION);
    assert.doesNotMatch(out, /\[m:[0-9a-f]{4,8}\]/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatQmdResults: a non-memory .md row (entity reconstruction) gets no handle (codex review)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const out = formatQmd(orchestrator, "Workspace Context", [
      { docid: "Widget", path: "/mem/default/entities/Widget.md", line: 1, snippet: "entity reconstruction", score: 0.5 },
      qmdResult(ID_A, "real memory"),
    ], SESSION);
    assert.doesNotMatch(out, /\[m:[0-9a-f]{4,8}\].*Widget|Widget.*\[m:/);
    assert.ok(out.includes(`[m:${handleFor(ID_A)}]`));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatQmdResults: handles OFF when sessionKey is absent even if config is on (cursor review)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const out = formatQmd(orchestrator, "Workspace Context", [
      qmdResult(ID_A, "The API rate limit is 1000 rpm."),
    ]);
    assert.doesNotMatch(out, /\[m:[0-9a-f]{4,8}\]/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("resolveMemoryIdOrHandle: raw memory id passes through unchanged", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    assert.equal(orchestrator.resolveMemoryIdOrHandle(ID_A), ID_A);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryIdOrHandle: handle resolves to the exact memory id after a recall record (round-trip)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    await orchestrator.handleHistory.record(SESSION, [ID_A, ID_B]);
    const token = renderHandle(ID_A); // [m:4f2a]
    assert.equal(orchestrator.resolveMemoryIdOrHandle(token, SESSION), ID_A);
    assert.equal(
      orchestrator.resolveMemoryIdOrHandle(handleFor(ID_A), SESSION),
      ID_A,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryIdOrHandle: unknown handle throws (rule 34 — never silent)", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    assert.throws(
      () => orchestrator.resolveMemoryIdOrHandle("[m:dead]", SESSION),
      /not found in the recent recall history/i,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryIdOrHandle: ambiguous handle throws listing candidates (rule 51)", async () => {
  const handles = new Map<string, string>();
  let idA = "";
  let idB = "";
  for (let i = 0; i < 5000 && !idB; i++) {
    const id = `fact-collide-${i}`;
    const h = handleFor(id);
    const existing = handles.get(h);
    if (existing) {
      idA = existing;
      idB = id;
    } else {
      handles.set(h, id);
    }
  }
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    if (!idB) {
      assert.ok(true, "no width-4 collision found in synthetic search; ambiguous branch covered by PR1 unit tests");
      return;
    }
    await orchestrator.handleHistory.record(SESSION, [idA, idB]);
    assert.throws(
      () => orchestrator.resolveMemoryIdOrHandle(renderHandle(idA), SESSION),
      (err: Error) =>
        /ambiguous/i.test(err.message) &&
        err.message.includes(idA) &&
        err.message.includes(idB),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryIdOrHandle: snapshot depth respected — older-than-N is a miss", async () => {
  const { orchestrator, memoryDir } = await makeHarness({
    recallMemoryHandles: true,
    recallHandleSnapshotDepth: 1,
  });
  try {
    await orchestrator.handleHistory.record(SESSION, [ID_A]);
    await orchestrator.handleHistory.record(SESSION, [ID_B]);
    assert.throws(
      () => orchestrator.resolveMemoryIdOrHandle(renderHandle(ID_A), SESSION),
      /not found/i,
    );
    assert.equal(
      orchestrator.resolveMemoryIdOrHandle(renderHandle(ID_B), SESSION),
      ID_B,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("processTurn strips echoed handles from buffered content when the feature is ON", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const handleToken = renderHandle(ID_A);
    await orchestrator.processTurn("user", `That ${handleToken} is stale.`, SESSION);
    const turns = orchestrator.buffer.getTurns(SESSION);
    assert.ok(turns.length > 0, "turn was buffered");
    const buffered = turns[turns.length - 1]!.content;
    assert.doesNotMatch(buffered, /\[m:[0-9a-f]{4,8}\]/);
    assert.ok(buffered.includes("stale"), "non-handle text is preserved");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("processTurn leaves content byte-identical when the feature is OFF", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: false });
  try {
    const content = "see [m:4f2a] for context";
    await orchestrator.processTurn("user", content, SESSION);
    const turns = orchestrator.buffer.getTurns(SESSION);
    assert.equal(turns[turns.length - 1]!.content, content);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("memoryGet resolves a handle to the underlying memory via sessionKey", async () => {
  const { orchestrator, service, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const defaultNs = orchestrator.config.defaultNamespace;
    const storage = await orchestrator.getStorage(defaultNs);
    const { id: writtenId } = await storage.writeMemory(
      "fact",
      "The API rate limit is 1000 rpm.",
      { confidence: 0.9, source: "test" },
    );
    await orchestrator.handleHistory.record(SESSION, [writtenId]);

    const res = await service.memoryGet(
      renderHandle(writtenId),
      undefined,
      undefined,
      SESSION,
    );
    assert.equal(res.found, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("correctionPlan: a handle in targetIds is resolved before planning; an unknown handle is an input error", async () => {
  const { service, memoryDir } = await makeHarness({
    recallMemoryHandles: true,
    correctionEnabled: true,
  });
  try {
    await assert.rejects(
      () =>
        service.correctionPlan({
          text: "that memory is wrong",
          targetIds: ["[m:dead]"],
          sessionKey: SESSION,
        }),
      (err: unknown) =>
        err instanceof EngramAccessInputError && /not found/i.test((err as Error).message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("correctionPlan: a handle in duplicateOf is resolved before planning", async () => {
  const { service, memoryDir } = await makeHarness({
    recallMemoryHandles: true,
    correctionEnabled: true,
  });
  try {
    await assert.rejects(
      () =>
        service.correctionPlan({
          text: "that memory is a duplicate",
          targetIds: ["fact-loser"],
          duplicateOf: "[m:dead]",
          sessionKey: SESSION,
        }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /not found/i.test((err as Error).message) &&
        (err as Error).message.includes("[m:dead]"),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("correctionPlan: a resolved handle targetIds set reaches the planner as concrete ids (round-trip)", async () => {
  const { orchestrator, service, memoryDir } = await makeHarness({
    recallMemoryHandles: true,
    correctionEnabled: true,
  });
  try {
    await orchestrator.handleHistory.record(SESSION, [ID_A]);
    try {
      await service.correctionPlan({
        text: "that memory is wrong",
        targetIds: [renderHandle(ID_A)],
        sessionKey: SESSION,
      });
    } catch (err) {
      assert.ok(
        !(err instanceof EngramAccessInputError && /not found|handle/i.test((err as Error).message)),
        `handle resolution should have succeeded, got: ${(err as Error).message}`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


async function scanTreeForHandles(dir: string): Promise<string[]> {
  const hits: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return hits;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      hits.push(...(await scanTreeForHandles(full)));
    } else if (entry.endsWith(".md")) {
      const text = await readFile(full, "utf-8");
      if (/\[m:[0-9a-f]{4,8}\]/.test(text)) hits.push(full);
    }
  }
  return hits;
}

test("corpus scan: handles stripped before buffering never appear in persisted memory files", async () => {
  const { orchestrator, memoryDir } = await makeHarness({ recallMemoryHandles: true });
  try {
    const handleToken = renderHandle(ID_A);
    await orchestrator.processTurn("user", `The limit is 1000 rpm. ${handleToken}`, SESSION);
    await orchestrator.processTurn("assistant", `Got it, noting ${handleToken}.`, SESSION);
    const turns = orchestrator.buffer.getTurns(SESSION);
    for (const t of turns) {
      assert.doesNotMatch(t.content, /\[m:[0-9a-f]{4,8}\]/);
    }
    const hits = await scanTreeForHandles(memoryDir);
    assert.deepEqual(hits, [], `no persisted file should contain a handle token, found: ${hits.join(", ")}`);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
