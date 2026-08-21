import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { EngramAccessHttpServer } from "../access-http.js";
import type { EngramAccessService } from "../access-service.js";
import type {
  ReviewDeckActionReceipt,
  ReviewDeckActionRequest,
  ReviewDeckPage,
  ReviewDeckUndoRequest,
} from "./review-deck.js";

const TOKEN = "test-token";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(): ReviewDeckPage {
  return { schemaVersion: 1, items: [], total: 0 };
}

function receipt(
  action: ReviewDeckActionReceipt["action"] = "keep",
): ReviewDeckActionReceipt {
  return {
    schemaVersion: 1,
    receiptId: "receipt-1",
    itemId: "item-1",
    action,
    outcome: "applied",
    effect: action,
    undoAvailable: action !== "undo",
  };
}

function mockService(overrides: Partial<EngramAccessService> = {}): EngramAccessService {
  return {
    reviewDeckEnabled: true,
    reviewDeckList: async () => page(),
    reviewDeckAction: async () => receipt("keep"),
    reviewDeckUndo: async () => receipt("undo"),
    reviewQueue: async () => ({ found: true, runId: "existing-review" }),
    ...overrides,
  } as unknown as EngramAccessService;
}

async function startServer(
  service: EngramAccessService,
  extras: ConstructorParameters<typeof EngramAccessHttpServer>[0] extends infer T
    ? T extends { service: EngramAccessService }
      ? Omit<T, "service" | "port" | "adminConsoleEnabled">
      : never
    : never = { authToken: TOKEN },
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    adminConsoleEnabled: false,
    ...extras,
  });
  const status = await server.start();
  return { port: status.port, stop: () => server.stop() };
}

async function jsonRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN}`,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const keepBody: ReviewDeckActionRequest = {
  schemaVersion: 1,
  itemId: "item-1",
  revision: "rv1:abc",
  action: "keep",
  idempotencyKey: "key-1",
};

const undoBody: ReviewDeckUndoRequest = {
  schemaVersion: 1,
  receiptId: "receipt-1",
  expectedRevision: "rv1:abc",
  idempotencyKey: "key-undo",
};

test("canonical and engram alias list routes return schemaVersion 1", async () => {
  const { port, stop } = await startServer(mockService());
  try {
    for (const prefix of ["/remnic/v1", "/engram/v1"] as const) {
      const listed = await jsonRequest(port, `${prefix}/review/deck?limit=1`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.schemaVersion, 1);
      const acted = await jsonRequest(port, `${prefix}/review/deck/action`, {
        method: "POST",
        body: keepBody,
      });
      assert.equal(acted.status, 200);
      assert.equal(acted.body.schemaVersion, 1);
      const undone = await jsonRequest(port, `${prefix}/review/deck/undo`, {
        method: "POST",
        body: undoBody,
      });
      assert.equal(undone.status, 200);
      assert.equal(undone.body.schemaVersion, 1);
    }
  } finally {
    await stop();
  }
});

test("invalid cursor, limit, action, revision, and missing idempotency key are client errors", async () => {
  const { port, stop } = await startServer(mockService());
  try {
    const cases: Array<{ path: string; method?: string; body?: unknown; message: RegExp }> = [
      { path: "/engram/v1/review/deck?limit=1&cursor=%%%", message: /cursor is malformed/ },
      { path: "/engram/v1/review/deck", message: /limit is required/ },
      { path: "/engram/v1/review/deck?limit=abc", message: /limit must be an integer/ },
      { path: "/engram/v1/review/deck?limit=0", message: /limit must be an integer from 1 to 100/ },
      { path: "/engram/v1/review/deck?limit=101", message: /limit must be an integer from 1 to 100/ },
      {
        path: "/engram/v1/review/deck/action",
        method: "POST",
        body: { ...keepBody, action: "later" },
        message: /action must be one of/,
      },
      {
        path: "/engram/v1/review/deck/action",
        method: "POST",
        body: { ...keepBody, revision: "" },
        message: /revision is required/,
      },
      {
        path: "/engram/v1/review/deck/action",
        method: "POST",
        body: { ...keepBody, idempotencyKey: undefined },
        message: /idempotencyKey is required/,
      },
      {
        path: "/engram/v1/review/deck/action",
        method: "POST",
        body: { ...keepBody, action: "prepare_fix", correctionText: "   " },
        message: /correctionText is required/,
      },
    ];
    for (const item of cases) {
      const result = await jsonRequest(port, item.path, { method: item.method, body: item.body });
      assert.equal(result.status, 400, item.path);
      assert.match(String(result.body.error), item.message);
    }
  } finally {
    await stop();
  }
});

test("POST body principal and namespace are ignored in favor of the boundary", async () => {
  let seen: { namespace?: string; principal?: string } | undefined;
  const { port, stop } = await startServer(
    mockService({
      reviewDeckAction: async (_req, opts) => {
        seen = { namespace: opts.namespace, principal: opts.principal };
        return receipt("keep");
      },
    }),
    { authToken: TOKEN, principal: "boundary-principal" },
  );
  try {
    const result = await jsonRequest(
      port,
      "/engram/v1/review/deck/action?namespace=boundary-ns",
      {
        method: "POST",
        body: {
          ...keepBody,
          namespace: "body-ns",
          principal: "body-principal",
        },
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(seen, { namespace: "boundary-ns", principal: "boundary-principal" });
  } finally {
    await stop();
  }
});

test("a read-only token cannot call action or undo", async () => {
  const { port, stop } = await startServer(mockService(), {
    authTokenEntriesGetter: () => [
      { token: "reader", capabilities: { version: 1, ops: ["review_deck_list"] } },
    ],
  });
  try {
    const listed = await jsonRequest(port, "/engram/v1/review/deck?limit=1", { token: "reader" });
    assert.equal(listed.status, 200);
    const acted = await jsonRequest(port, "/engram/v1/review/deck/action", {
      method: "POST",
      token: "reader",
      body: keepBody,
    });
    assert.equal(acted.status, 403);
    const undone = await jsonRequest(port, "/engram/v1/review/deck/undo", {
      method: "POST",
      token: "reader",
      body: undoBody,
    });
    assert.equal(undone.status, 403);
  } finally {
    await stop();
  }
});

test("disabled gate returns 404 for deck routes while review-queue still works", async () => {
  let queueCalled = false;
  let deckCalled = false;
  const { port, stop } = await startServer(
    mockService({
      reviewDeckEnabled: false,
      reviewDeckList: async () => {
        deckCalled = true;
        return page();
      },
      reviewQueue: async () => {
        queueCalled = true;
        return { found: true, runId: "existing-review" };
      },
    }),
  );
  try {
    for (const path of [
      "/engram/v1/review/deck?limit=1",
      "/remnic/v1/review/deck?limit=1",
      "/engram/v1/review/deck/action",
      "/remnic/v1/review/deck/undo",
    ]) {
      const method = path.includes("/action") || path.includes("/undo") ? "POST" : "GET";
      const result = await jsonRequest(port, path, {
        method,
        body: method === "POST" ? keepBody : undefined,
      });
      assert.equal(result.status, 404, path);
      assert.equal(result.body.code, "not_found");
    }
    assert.equal(deckCalled, false);
    const queue = await jsonRequest(port, "/engram/v1/review-queue");
    assert.equal(queue.status, 200);
    assert.equal(queueCalled, true);
  } finally {
    await stop();
  }
});

test("cancellation reaches the deck action executor", async () => {
  const started = deferred<void>();
  const settled = deferred<void>();
  const forceRelease = deferred<void>();
  let observed: AbortSignal | undefined;
  const { port, stop } = await startServer(
    mockService({
      reviewDeckAction: async (_req, opts) => {
        observed = opts.signal;
        started.resolve();
        try {
          await Promise.race([
            forceRelease.promise,
            new Promise<void>((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
            }),
          ]);
        } finally {
          settled.resolve();
        }
        if (opts.signal?.aborted) throw opts.signal.reason;
        return receipt("keep");
      },
    }),
  );
  try {
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/engram/v1/review/deck/action",
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
    });
    client.on("error", () => {});
    client.end(JSON.stringify(keepBody));
    await started.promise;
    assert.ok(observed, "abort signal must reach the executor");
    client.destroy();
    await settled.promise;
    assert.equal(observed.aborted, true);
  } finally {
    forceRelease.resolve();
    await stop();
  }
});
