import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestFlushPlanNotes } from "./delegate-flush-plan-ingest.js";
import { buildSnapshotPaths, pinSnapshotDirectory } from "./delegate-flush-plan-directory.js";

interface ObserveServer {
  port: number;
  close: () => Promise<void>;
}

interface FlushPlanFiles {
  workspaceDir: string;
  plan: string;
  inflight: string;
  rotating: string;
  lock: string;
}

test("keeps a host append made while the flush post is in flight", async () => {
  const files = await createFlushPlanFiles("append");
  const observed: string[] = [];
  let server: ObserveServer | undefined;
  try {
    await mkdir(path.dirname(files.plan), { recursive: true });
    await writeFile(files.plan, "- first note\n", "utf8");
    server = await startObserveServer(async (content) => {
      observed.push(content);
      if (observed.length === 1) {
        await appendFile(files.plan, "- appended while posting\n", "utf8");
      }
    });

    await ingestFlushPlanNotes(optionsFor(server.port, files.workspaceDir, "append"));

    assert.deepEqual(observed, ["- first note\n", "- appended while posting\n"]);
    assert.equal(await readIfPresent(files.plan), undefined);
    assert.equal(await readIfPresent(files.inflight), undefined);
  } finally {
    await server?.close();
    await rm(files.workspaceDir, { recursive: true, force: true });
  }
});

test("recovers rotating and inflight leftovers in write order", async () => {
  const files = await createFlushPlanFiles("recovery");
  const observed: string[] = [];
  let server: ObserveServer | undefined;
  try {
    await mkdir(path.dirname(files.plan), { recursive: true });
    await writeFile(files.rotating, "- stranded during rotation\n", "utf8");
    await writeFile(files.inflight, "- stranded in flight\n", "utf8");
    await writeFile(files.plan, "- newer host note\n", "utf8");
    server = await startObserveServer((content) => {
      observed.push(content);
    });

    await ingestFlushPlanNotes(optionsFor(server.port, files.workspaceDir, "recovery"));

    assert.deepEqual(observed, [
      "- stranded in flight\n- stranded during rotation\n- newer host note\n",
    ]);
    assert.equal(await readIfPresent(files.plan), undefined);
    assert.equal(await readIfPresent(files.inflight), undefined);
    assert.equal(await readIfPresent(files.rotating), undefined);
  } finally {
    await server?.close();
    await rm(files.workspaceDir, { recursive: true, force: true });
  }
});

test("stops after lock loss during a flush instead of posting another chunk", async () => {
  const files = await createFlushPlanFiles("lock-loss");
  const notes = Array.from({ length: 2_000 }, (_, index) => `- note ${index} ${"x".repeat(70)}\n`).join("");
  const observed: string[] = [];
  let server: ObserveServer | undefined;
  try {
    await mkdir(path.dirname(files.plan), { recursive: true });
    await writeFile(files.plan, notes, "utf8");
    server = await startObserveServer(async (content) => {
      observed.push(content);
      if (observed.length === 1) await unlink(files.lock);
    });

    await ingestFlushPlanNotes(optionsFor(server.port, files.workspaceDir, "lock-loss"));

    assert.equal(observed.length, 1, "lock loss declines the rest of this flush");
    assert.ok(observed[0] !== undefined && observed[0].length < notes.length);
    assert.equal(await readIfPresent(files.inflight), notes, "the new owner receives the untouched snapshot");
  } finally {
    await server?.close();
    await rm(files.workspaceDir, { recursive: true, force: true });
  }
});

test("keeps snapshot writes in the pinned directory when a parent is swapped mid-flush", async (t) => {
  const files = await createFlushPlanFiles("parent-swap");
  const stateDir = path.dirname(files.plan);
  await mkdir(stateDir, { recursive: true });
  const probe = await pinSnapshotDirectory(buildSnapshotPaths(files.plan));
  if (probe.kind !== "pinned") {
    t.skip("descriptor directory does not resolve the held fd; path-based I/O is the only option");
    await rm(files.workspaceDir, { recursive: true, force: true });
    return;
  }
  await probe.close();
  const movedStateDir = `${stateDir}.moved`;
  const decoyDir = path.join(files.workspaceDir, "decoy");
  const lockName = path.basename(files.lock);
  const notes = Array.from({ length: 2_000 }, (_, index) => `- note ${index} ${"x".repeat(70)}\n`).join("");
  const observed: string[] = [];
  let server: ObserveServer | undefined;
  try {
    await mkdir(decoyDir, { recursive: true });
    await writeFile(files.plan, notes, "utf8");
    server = await startObserveServer(async (content) => {
      observed.push(content);
      if (observed.length !== 1) return;
      await copyFile(files.lock, path.join(decoyDir, lockName));
      await rename(stateDir, movedStateDir);
      await symlink(decoyDir, stateDir);
    });
    await ingestFlushPlanNotes(optionsFor(server.port, files.workspaceDir, "parent-swap"));
    assert.ok(observed.length > 1, "the flush keeps draining through the pinned directory");
    assert.equal(observed.join(""), notes, "every note reaches the daemon exactly once");
    assert.deepEqual(
      (await readdir(decoyDir)).filter((entry) => entry !== lockName),
      [],
      "no snapshot file may land in the swapped-in directory",
    );
    assert.equal(await readIfPresent(path.join(movedStateDir, path.basename(files.inflight))), undefined);
  } finally {
    await server?.close();
    await rm(stateDir, { force: true });
    await rm(files.workspaceDir, { recursive: true, force: true });
  }
});

async function createFlushPlanFiles(serviceId: string): Promise<FlushPlanFiles> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flush-plan-test-"));
  const plan = path.join(workspaceDir, "state", "plugins", serviceId, "flush-plan.md");
  return {
    workspaceDir,
    plan,
    inflight: `${plan}.inflight`,
    rotating: `${plan}.rotating`,
    lock: `${plan}.lock`,
  };
}

function optionsFor(port: number, workspaceDir: string, serviceId: string) {
  return {
    target: {
      host: "127.0.0.1",
      port,
      resolveAuthToken: () => ({ token: "test-token", source: "daemon configuration" as const }),
    },
    serviceId,
    workspaceDir,
    sessionKey: "test-session",
    namespace: undefined,
    remainingTimeoutMs: () => 10_000,
  } satisfies Parameters<typeof ingestFlushPlanNotes>[0];
}

async function startObserveServer(onObserve: (content: string) => Promise<void> | void): Promise<ObserveServer> {
  const server = http.createServer((request, response) => {
    const validRequest =
      request.method === "POST" &&
      request.url === "/engram/v1/observe" &&
      request.headers.authorization === "Bearer test-token" &&
      request.headers["content-type"] === "application/json";
    if (!validRequest) {
      response.statusCode = 400;
      response.end();
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const body = JSON.parse(raw) as {
          sessionKey?: unknown;
          messages?: unknown;
        };
        const message =
          Array.isArray(body.messages) &&
          body.messages.length === 1 &&
          typeof body.messages[0] === "object" &&
          body.messages[0] !== null
            ? (body.messages[0] as { content?: unknown })
            : undefined;
        if (body.sessionKey !== "test-session" || typeof message?.content !== "string") {
          response.statusCode = 400;
          response.end();
          return;
        }
        await onObserve(message.content);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      })().catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address !== "object") {
    await closeServer(server);
    throw new Error("observe stub did not bind");
  }
  return { port: address.port, close: () => closeServer(server) };
}

async function closeServer(server: http.Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
