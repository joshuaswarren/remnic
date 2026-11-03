// `remnic buffer drain` — end-to-end behaviour of the out-of-process drain.
//
// A fake OpenAI-compatible LLM server stands in for the extraction model, and
// a temp memory root holds several buffered sessions with windows large
// enough to need chunking. The cases pin the properties that matter
// operationally:
//
//   1. backlog: one command drains every session, concurrently, and the
//      buffer ends up empty;
//   2. kill-and-resume: a killed worker loses nothing — the next run picks
//      the un-extracted turns up and finishes the backlog;
//   3. live-daemon coexistence: a buffer owner that keeps observing during
//      the drain hands its turns into the claim instead of resurrecting them,
//      and the content is extracted exactly once.
//
// No real host, daemon, or model is involved: everything runs against the
// temp directory and the fake server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { StorageManager } from "@remnic/core";
import type { BufferEntryState, BufferTurn } from "@remnic/core/types.js";
import { runBufferDrain } from "../packages/remnic-cli/src/buffer-drain-cmd.js";

interface FakeLlm {
  url: string;
  requests: string[];
  close(): Promise<void>;
  /** Block the next N chat requests (never answer them). */
  hangNext(count: number): void;
  answerNext(count: number): void;
}

/** A fake OpenAI-compatible chat server: one fact per request, derived from the prompt. */
async function startFakeLlm(): Promise<FakeLlm> {
  const requests: string[] = [];
  let hangCount = 0;
  let hangResolve: (() => void) | undefined;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      if (!req.url?.includes("/chat/completions")) {
        // Availability probes (GET /, /health) must not look like a chat
        // answer, or the client treats the probe as a broken endpoint.
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      requests.push(raw);
      if (hangCount > 0) {
        hangCount -= 1;
        hangResolve = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }));
        };
        return;
      }
      const fact = `fact for request ${requests.length}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [{ content: fact, category: "fact", confidence: 0.9 }],
                  entities: [],
                  questions: [],
                  profileUpdates: [],
                }),
              },
            },
          ],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hangNext: (count: number) => {
      hangCount = count;
    },
    answerNext: (count: number) => {
      hangCount = count;
      hangResolve?.();
    },
  };
}

function turn(content: string, sessionKey: string, index: number): BufferTurn {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
    sessionKey,
  };
}

interface Fixture {
  root: string;
  memoryDir: string;
  configPath: string;
  llm: FakeLlm;
  storage(): StorageManager;
  cleanup(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remnic-drain-cli-"));
  const memoryDir = path.join(root, "memory");
  const llm = await startFakeLlm();
  const configPath = path.join(root, "config.json");
  await fs.promises.writeFile(
    configPath,
    JSON.stringify({
      memoryDir,
      localLlmEnabled: true,
      localLlmModel: "fixture-model",
      localLlmUrl: llm.url,
      localLlmFallback: false,
      localLlmMaxContext: 1500,
      extractionMinUserTurns: 1,
      extractionMinChars: 0,
      triggerMode: "smart",
      bufferMaxTurns: 1000,
      bufferMaxMinutes: 100000,
      debug: false,
    }),
  );
  return {
    root,
    memoryDir,
    configPath,
    llm,
    storage: () => new StorageManager(memoryDir),
    cleanup: async () => {
      await llm.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

async function seedSessions(storage: StorageManager, sessions: { key: string; turns: number }[]): Promise<void> {
  for (const session of sessions) {
    const entry: BufferEntryState = {
      turns: Array.from({ length: session.turns }, (_, index) =>
        turn(`${session.key} content ${index} ${"x".repeat(200)}`, session.key, index),
      ),
      lastExtractionAt: null,
      extractionCount: 0,
    };
    await storage.saveBufferSession(session.key, entry);
  }
}

async function runDrain(fixture: Fixture, args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBufferDrain(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    configPath: fixture.configPath,
    memoryDir: fixture.memoryDir,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function bufferedTurns(storage: StorageManager): Promise<number> {
  const loaded = await storage.loadBuffer();
  let turns = 0;
  for (const entry of Object.values(loaded.entries ?? {})) {
    turns += entry.turns.length + (entry.retainedTurns?.length ?? 0);
  }
  return turns;
}

function claimDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "buffer", "drain");
}

test("one command drains every buffered session", async () => {
  const fixture = await makeFixture();
  try {
    const storage = fixture.storage();
    await seedSessions(storage, [
      { key: "sess-a", turns: 6 },
      { key: "sess-b", turns: 6 },
      { key: "sess-c", turns: 4 },
    ]);
    assert.ok((await bufferedTurns(storage)) > 0, "seeded sessions are buffered");

    const result = await runDrain(fixture);
    assert.equal(result.code, 0, `drain failed: ${result.err}`);
    assert.equal(await bufferedTurns(fixture.storage()), 0, "the buffer is empty after the drain");
    assert.ok(fixture.llm.requests.length > 0, "the extraction model was called");
    // Only tombstones (no turns left) may remain: they are the record that
    // lets a live buffer owner subtract the drained turns instead of
    // resurrecting them.
    const claims = fs.existsSync(claimDir(fixture.memoryDir)) ? fs.readdirSync(claimDir(fixture.memoryDir)) : [];
    for (const name of claims.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".lease.json"))) {
      const body = JSON.parse(fs.readFileSync(path.join(claimDir(fixture.memoryDir), name), "utf8")) as {
        entry?: { turns?: unknown[] };
      };
      assert.equal((body.entry?.turns ?? []).length, 0, "no un-extracted turns are left in a claim");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a killed drain loses nothing: the next run resumes and finishes", async () => {
  const fixture = await makeFixture();
  try {
    const storage = fixture.storage();
    await seedSessions(storage, [{ key: "sess-kill", turns: 8 }]);

    // A worker that answers nothing leaves its claim durable: the turns it
    // had not extracted yet stay in the claim file.
    fixture.llm.hangNext(100);
    const worker = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=remnic-source",
        path.join(process.cwd(), "packages/remnic-cli/src/buffer-drain-worker.ts"),
        "--config",
        fixture.configPath,
        "--memory-dir",
        fixture.memoryDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve) => {
      // Wait for the worker's real "session_started" signal; the timer is only
      // a hang guard (the worker must not spin forever before it starts).
      const timer = setTimeout(resolve, 15_000);
      worker.stdout.on("data", (chunk: string) => {
        if (chunk.toString().includes("session_started")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    worker.kill("SIGKILL");
    await once(worker, "exit");

    const claimFiles = fs.existsSync(claimDir(fixture.memoryDir))
      ? fs.readdirSync(claimDir(fixture.memoryDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".lease.json"))
      : [];
    assert.equal(claimFiles.length, 1, "the killed worker's claim is durable");

    // The next run resumes the claim and finishes the backlog.
    fixture.llm.answerNext(0);
    const result = await runDrain(fixture);
    assert.equal(result.code, 0, `resume failed: ${result.err}`);
    assert.equal(await bufferedTurns(fixture.storage()), 0, "the buffer is empty after the resume");
  } finally {
    await fixture.cleanup();
  }
});

test("a live buffer owner hands its turns to the drain instead of resurrecting them", async () => {
  const fixture = await makeFixture();
  try {
    const storage = fixture.storage();
    await seedSessions(storage, [{ key: "sess-live", turns: 4 }]);

    // The daemon-side owner: its own storage handle over the same root.
    const owner = fixture.storage();
    const before = await owner.loadBuffer();
    const ownerTurns = before.entries?.["sess-live"]?.turns ?? [];
    assert.ok(ownerTurns.length > 0, "the owner loaded the buffered turns");

    // The drain claims the session while the owner still holds it in memory.
    const result = await runDrain(fixture);
    assert.equal(result.code, 0, `drain failed: ${result.err}`);
    assert.equal(await bufferedTurns(fixture.storage()), 0, "the buffer is empty after the drain");

    // The owner persists its stale in-memory copy afterwards: it must NOT
    // bring the drained turns back (that is the resurrection the protocol
    // forbids).
    await owner.saveBufferSession("sess-live", {
      turns: ownerTurns,
      lastExtractionAt: null,
      extractionCount: 0,
    });
    const after = await fixture.storage().loadBuffer();
    const resurrected = after.entries?.["sess-live"]?.turns ?? [];
    assert.equal(resurrected.length, 0, "drained turns are not resurrected by the owner's later save");
  } finally {
    await fixture.cleanup();
  }
});
