import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { abortError } from "./abort-error.js";
import { QmdDaemonSession } from "./qmd-daemon-session.js";
import { createInflightJoiner, rankDocumentsUntilAbortParallel } from "./qmd-mcp-cancel.js";
import { QmdClient } from "./qmd.js";
import type { CommandChildProcess } from "./runtime/child-process.js";
import type { QmdSearchResult } from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("in-flight joiner runs identical work once", async () => {
  const joiner = createInflightJoiner<string>();
  let runs = 0;
  const run = () => {
    runs += 1;
    return delay(20).then(() => "shared");
  };
  const [a, b] = await Promise.all([joiner.join("same", undefined, run), joiner.join("same", undefined, run)]);
  assert.equal(a, "shared");
  assert.equal(b, "shared");
  assert.equal(runs, 1);
});

test("aborting one of two waiters does not cancel the shared call", async () => {
  const joiner = createInflightJoiner<string>();
  let runs = 0;
  let sharedAborted = false;
  const run = (signal: AbortSignal) => {
    runs += 1;
    signal.addEventListener("abort", () => {
      sharedAborted = true;
    });
    return delay(30).then(() => "kept");
  };
  const ac = new AbortController();
  const leaving = joiner.join("same", ac.signal, run);
  const staying = joiner.join("same", undefined, run);
  await delay(5);
  ac.abort();
  await assert.rejects(leaving, (err: Error) => err.name === "AbortError");
  assert.equal(await staying, "kept");
  assert.equal(runs, 1);
  assert.equal(sharedAborted, false);
});

test("aborting the only waiter aborts the shared signal", async () => {
  const joiner = createInflightJoiner<string>();
  let shared: AbortSignal | undefined;
  const run = (signal: AbortSignal) => {
    shared = signal;
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError("run aborted")));
    });
  };
  const ac = new AbortController();
  const pending = joiner.join("only", ac.signal, run);
  await delay(5);
  ac.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  assert.equal(shared?.aborted, true);
});

test("a pre-aborted signal does not start work", async () => {
  const joiner = createInflightJoiner<string>();
  let runs = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    joiner.join("pre", ac.signal, async () => {
      runs += 1;
      return "no";
    }),
    (err: Error) => err.name === "AbortError"
  );
  assert.equal(runs, 0);
});

test("rank loop stops between documents and the next batch is not charged the remainder", async () => {
  const ac = new AbortController();
  let calls = 0;
  const abandoned = rankDocumentsUntilAbortParallel(5, 1, ac.signal, async () => {
    calls += 1;
    await delay(40);
    return 1;
  });
  await delay(50);
  ac.abort();
  const stoppedAt = Date.now();
  await assert.rejects(abandoned, (err: Error) => err.name === "AbortError");
  const stopMs = Date.now() - stoppedAt;
  assert.ok(calls < 5, `cancelled rerank still scored ${calls} documents`);
  assert.ok(stopMs < 120, `worker kept scoring for ${stopMs}ms after abort`);

  const followStarted = Date.now();
  const scores = await rankDocumentsUntilAbortParallel(5, 1, undefined, async (index) => {
    await delay(5);
    return index;
  });
  const followMs = Date.now() - followStarted;
  assert.deepEqual(scores, [0, 1, 2, 3, 4]);
  assert.ok(followMs < 150, `following batch took ${followMs}ms`);
});

type Reply = (payload: unknown) => void;

function createScriptedChild(onLine: (line: string, reply: Reply) => void): CommandChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    pid: number;
    stdin: {
      destroyed: boolean;
      write: (chunk: string, cb?: (err?: Error | null) => void) => boolean;
      on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
  };
  const reply: Reply = (payload) => {
    stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
  };
  child.killed = false;
  child.pid = 4242;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    destroyed: false,
    on() {
      return child.stdin;
    },
    write(chunk, cb) {
      queueMicrotask(() => {
        for (const line of String(chunk).split("\n")) {
          if (line.trim()) onLine(line, reply);
        }
      });
      cb?.(null);
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0);
    return true;
  };
  return child as unknown as CommandChildProcess;
}

function scriptedQueryServer(lines: string[]) {
  let held: number | null = null;
  const queue: number[] = [];
  const holdTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const serveNext = (reply: Reply) => {
    if (held !== null || queue.length === 0) return;
    const id = queue.shift();
    if (id === undefined) return;
    held = id;
    const timer = setTimeout(() => {
      if (held !== id) return;
      reply({
        jsonrpc: "2.0",
        id,
        result: { structuredContent: { results: [] } },
      });
      held = null;
      serveNext(reply);
    }, 2_000);
    holdTimers.set(id, timer);
  };

  return (line: string, reply: Reply) => {
    lines.push(line);
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { requestId?: number };
    };
    if (msg.method === "initialize" && msg.id !== undefined) {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "fake-qmd", version: "2.5.3" },
        },
      });
      return;
    }
    if (msg.method === "notifications/cancelled") {
      const requestId = msg.params?.requestId;
      if (requestId !== undefined && held === requestId) {
        const timer = holdTimers.get(requestId);
        if (timer) clearTimeout(timer);
        setTimeout(() => {
          if (held === requestId) held = null;
          const next = queue.shift();
          if (next !== undefined) {
            reply({
              jsonrpc: "2.0",
              id: next,
              result: { structuredContent: { results: [{ docid: "next" }] } },
            });
          }
        }, 40);
      }
      return;
    }
    if (msg.method === "tools/call" && msg.id !== undefined) {
      queue.push(msg.id);
      serveNext(reply);
    }
  };
}

function parsedLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startedSession(lines: string[]): Promise<QmdDaemonSession> {
  const session = new QmdDaemonSession("qmd", {}, undefined, () => createScriptedChild(scriptedQueryServer(lines)));
  assert.equal(await session.start(), true);
  return session;
}

test("an aborted tool call cancels the worker and the next call is not stuck behind it", async () => {
  const lines: string[] = [];
  const session = await startedSession(lines);
  const ac = new AbortController();
  const first = session.callTool("query", { query: "abandoned" }, 30_000, ac.signal);
  await delay(15);
  ac.abort();
  await assert.rejects(first, (err: Error) => err.name === "AbortError");

  const firstTool = parsedLines(lines).find((msg) => msg.method === "tools/call");
  const cancel = parsedLines(lines).find((msg) => msg.method === "notifications/cancelled");
  assert.ok(firstTool);
  assert.ok(cancel);
  const params = cancel?.params as { requestId?: number; reason?: string };
  assert.equal(params.requestId, firstTool?.id);
  assert.equal(params.reason, "client aborted");

  const started = Date.now();
  const second = await session.callTool("query", { query: "next" }, 30_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `following call took ${elapsed}ms; it queued behind the abandoned rerank`);
  const structured = (second as { structuredContent?: { results?: Array<{ docid?: string }> } }).structuredContent;
  assert.equal(structured?.results?.[0]?.docid, "next");
  await session.close();
});

test("a timed-out tool call cancels the worker and the next call is not stuck behind it", async () => {
  const lines: string[] = [];
  const session = await startedSession(lines);
  await assert.rejects(session.callTool("query", { query: "slow" }, 80), /timed out/);

  const firstTool = parsedLines(lines).find((msg) => msg.method === "tools/call");
  const cancel = parsedLines(lines).find((msg) => msg.method === "notifications/cancelled");
  const params = cancel?.params as { requestId?: number; reason?: string };
  assert.equal(params?.requestId, firstTool?.id);
  assert.match(String(params?.reason), /timed out/);

  const started = Date.now();
  await session.callTool("query", { query: "next" }, 30_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `following call took ${elapsed}ms; it queued behind the timed-out rerank`);
  await session.close();
});

type SearchInternals = {
  available: boolean;
  daemonAvailable: boolean;
  maybeProbeDaemon: () => Promise<void>;
  searchViaDaemon: (
    query: string,
    collection: string | undefined,
    maxResults: number,
    options: unknown,
    signal?: AbortSignal
  ) => Promise<QmdSearchResult[] | null>;
};

function daemonClient(): { client: QmdClient; internals: SearchInternals } {
  const client = new QmdClient("memories", 5, { daemonRecheckIntervalMs: 60_000 });
  const internals = client as unknown as SearchInternals;
  internals.maybeProbeDaemon = async () => {
    internals.available = true;
    internals.daemonAvailable = true;
  };
  return { client, internals };
}

const hit = (docid: string): QmdSearchResult => ({
  docid,
  path: "memory.md",
  snippet: "",
  score: 1,
  transport: "daemon",
});

test("identical search() calls share one daemon query until the last waiter aborts", async () => {
  const { client, internals } = daemonClient();
  let calls = 0;
  let shared: AbortSignal | undefined;
  let release: (value: QmdSearchResult[]) => void = () => {};
  internals.searchViaDaemon = (_query, _collection, _maxResults, _options, signal) => {
    calls += 1;
    shared = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  const query = "joiner-share-recall-plan";
  const first = client.search(query, "memories", 5);
  const second = client.search(query, "memories", 5);
  await delay(10);
  assert.equal(calls, 1);

  const ac = new AbortController();
  const leaving = client.search(query, "memories", 5, undefined, { signal: ac.signal });
  await delay(5);
  assert.equal(calls, 1);
  ac.abort();
  await assert.rejects(leaving, (err: Error) => err.name === "AbortError");
  assert.equal(shared?.aborted, false);

  release([hit("kept")]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a[0]?.docid, "kept");
  assert.equal(b[0]?.docid, "kept");
});

test("the only in-flight search() abort cancels the shared daemon call", async () => {
  const { client, internals } = daemonClient();
  let calls = 0;
  let shared: AbortSignal | undefined;
  internals.searchViaDaemon = (_query, _collection, _maxResults, _options, signal) => {
    calls += 1;
    shared = signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(abortError("daemon aborted")));
    });
  };

  const ac = new AbortController();
  const pending = client.search("joiner-sole-abort", "memories", 5, undefined, { signal: ac.signal });
  await delay(10);
  assert.equal(calls, 1);
  ac.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  assert.equal(shared?.aborted, true);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    client.search("joiner-pre-aborted", "memories", 5, undefined, { signal: pre.signal }),
    (err: Error) => err.name === "AbortError"
  );
  assert.equal(calls, 1);
});
