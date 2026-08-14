import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessHttpServer } from "../access-http.js";
import type { EngramAccessService } from "../access-service.js";
import { SupportPassportError } from "./errors.js";

const TOKEN = "support-passport-owner-token";
const REVISION = "a".repeat(64);

function card(status: "pending_review" | "active" = "pending_review") {
  return {
    cardId: "card-one",
    title: "Plan changes",
    statement: "Tell me before plans change.",
    category: "transitions" as const,
    status,
    updatedAt: "2026-08-11T12:00:00.000Z",
    reviewBy: "2027-02-07T12:00:00.000Z",
    revision: REVISION,
  };
}

test("owner HTTP routes require bearer auth and use the trusted principal", async () => {
  const principals: string[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportListCards: async (principal: string) => {
      principals.push(principal);
      return [card("active")];
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/cards`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "SupportPassport helper-secret" } })).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Authorization");
    assert.deepEqual(await response.json(), { cards: [card("active")] });
    assert.deepEqual(principals, ["owner:alice"]);

    const queried = await fetch(`${url}?namespace=another-owner`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(queried.status, 400);
    const malformedPath = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/cards/%ZZ/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: REVISION, reasonCode: "owner-approved" }),
    });
    assert.equal(malformedPath.status, 400);
    assert.deepEqual(principals, ["owner:alice"]);
  } finally {
    await server.stop();
  }
});

test("owner HTTP writes reject unknown and path-owned fields before dispatch", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportApproveCard: async (...input: unknown[]) => {
      calls.push(input);
      return card("active");
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/cards/card-one/approve`;
  const request = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request({ expectedRevision: REVISION, reasonCode: "owner-approved", namespace: "other" })).status,
      400
    );
    assert.equal(
      (await request({ cardId: "another-card", expectedRevision: REVISION, reasonCode: "owner-approved" })).status,
      400
    );
    assert.equal(calls.length, 0);

    const response = await request({ expectedRevision: REVISION, reasonCode: "owner-approved" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { card: card("active") });
    const [principal, cardId, input, options] = calls[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    assert.equal(principal, "owner:alice");
    assert.equal(cardId, "card-one");
    assert.deepEqual(input, { expectedRevision: REVISION, reasonCode: "owner-approved" });
    assert.equal(typeof options.onCommitted, "function");
  } finally {
    await server.stop();
  }
});

test("manual owner HTTP drafts require the owner's review date", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async (...input: unknown[]) => {
      calls.push(input);
      return card();
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/drafts`;
  const request = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const draft = {
    title: "Plan changes",
    statement: "Tell me before plans change.",
    category: "transitions",
  };
  try {
    assert.equal((await request(draft)).status, 400);
    assert.equal(calls.length, 0);
    const response = await request({ ...draft, reviewBy: "2027-02-07T12:00:00.000Z" });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("owner HTTP forwards request cancellation to every support passport write", async () => {
  const observed: AbortSignal[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async (
      _principal: string,
      _input: unknown,
      options: { signal?: AbortSignal }
    ) => {
      assert.ok(options.signal);
      observed.push(options.signal);
      return card();
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.aborted, false);
  } finally {
    await server.stop();
  }
});

test("owner HTTP previews exact memory text with a consent revision", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportPreviewMemory: async (principal: string, memoryId: string) => {
      calls.push([principal, memoryId]);
      if (memoryId === "missing") return { found: false };
      return {
        found: true,
        memory: { id: memoryId, content: "Tell me before plans change.", revision: REVISION },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  const root = `http://127.0.0.1:${port}/engram/v1/support-passport/memories`;
  try {
    const found = await fetch(`${root}/memory-one`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), {
      found: true,
      memory: { id: "memory-one", content: "Tell me before plans change.", revision: REVISION },
    });
    const missing = await fetch(`${root}/missing`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { found: false });
    assert.deepEqual(calls, [
      ["owner:alice", "memory-one"],
      ["owner:alice", "missing"],
    ]);
  } finally {
    await server.stop();
  }
});

test("owner HTTP requires reviewed memory revisions before model drafting", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportGenerateDrafts: async (...input: unknown[]) => {
      calls.push(input);
      return [card()];
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/drafts/generate`;
  const request = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await request({ sourceMemoryIds: ["memory-one"], consent: true })).status, 400);
    assert.equal(calls.length, 0);
    const sourceMemoryRevisions = [{ memoryId: "memory-one", revision: REVISION }];
    const response = await request({ sourceMemoryIds: ["memory-one"], sourceMemoryRevisions, consent: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cards: [card()] });
    assert.equal(calls.length, 1);
    const [principal, input] = calls[0] as [string, Record<string, unknown>];
    assert.equal(principal, "owner:alice");
    const { onCommitted, ...forwardedInput } = input;
    assert.deepEqual(
      { ...forwardedInput, signal: undefined },
      { sourceMemoryIds: ["memory-one"], sourceMemoryRevisions, consent: true, signal: undefined }
    );
    assert.ok(input.signal instanceof AbortSignal);
    assert.equal(typeof onCommitted, "function");
  } finally {
    await server.stop();
  }
});

test("owner HTTP reserves write quota before concurrent dispatch", async () => {
  let markStarted: (() => void) | undefined;
  let finishWrite: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  let calls = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async () => {
      calls += 1;
      markStarted?.();
      await finish;
      return card();
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/drafts`;
  const request = () =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      }),
    });
  try {
    const firstPending = request();
    await started;
    const concurrent = await request();
    assert.equal(concurrent.status, 429);
    assert.equal(calls, 1, "the rate-limited request never reaches the service");

    finishWrite?.();
    const first = await firstPending;
    assert.equal(first.status, 200);
    assert.equal((await request()).status, 429, "the successful reservation remains a quota hit");
  } finally {
    finishWrite?.();
    await server.stop();
  }
});

test("owner HTTP releases reserved write quota when dispatch fails", async () => {
  let calls = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async () => {
      calls += 1;
      if (calls === 1) {
        throw new SupportPassportError("state_conflict", "Please retry.", 409);
      }
      return card();
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/engram/v1/support-passport/drafts`;
  const request = () =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      }),
    });
  try {
    assert.equal((await request()).status, 409);
    assert.equal((await request()).status, 200, "a failed write returns its reserved quota slot");
    assert.equal(calls, 2);
  } finally {
    await server.stop();
  }
});

test("owner HTTP keeps reserved quota when generated drafts commit before failure", async () => {
  let calls = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportGenerateDrafts: async (
      _principal: string,
      input: { onCommitted?: () => void }
    ) => {
      calls += 1;
      input.onCommitted?.();
      throw new SupportPassportError("state_conflict", "Draft cleanup failed.", 409);
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  const request = () =>
    fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/drafts/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        sourceMemoryIds: ["memory-one"],
        sourceMemoryRevisions: [{ memoryId: "memory-one", revision: REVISION }],
        consent: true,
      }),
    });
  try {
    assert.equal((await request()).status, 409);
    assert.equal((await request()).status, 429, "the committed draft keeps its reserved quota slot");
    assert.equal(calls, 1);
  } finally {
    await server.stop();
  }
});

test("owner HTTP keeps reserved quota when a card edit commits before failure", async () => {
  let calls = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReplaceCard: async (
      _principal: string,
      _cardId: string,
      _input: unknown,
      options: { onCommitted?: () => void }
    ) => {
      calls += 1;
      options.onCommitted?.();
      throw new SupportPassportError("storage_conflict", "Draft cleanup failed.", 409);
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  const request = () =>
    fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/cards/card-one`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
        expectedRevision: REVISION,
      }),
    });
  try {
    assert.equal((await request()).status, 409);
    assert.equal((await request()).status, 429, "the committed edit keeps its reserved quota slot");
    assert.equal(calls, 1);
  } finally {
    await server.stop();
  }
});

test("owner HTTP forwards commit accounting to manual drafts and grant creation", async () => {
  const callbacks: Array<() => void> = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async (
      _principal: string,
      _input: unknown,
      options: { onCommitted?: () => void }
    ) => {
      assert.equal(typeof options.onCommitted, "function");
      callbacks.push(options.onCommitted!);
      return card();
    },
    supportPassportCreateGrant: async (_principal: string, _input: unknown, options: { onCommitted?: () => void }) => {
      assert.equal(typeof options.onCommitted, "function");
      callbacks.push(options.onCommitted!);
      return {
        grantId: "grant-one",
        secret: "s".repeat(43),
        expiresAt: "2026-08-11T14:00:00.000Z",
        version: 1,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 2,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  try {
    const draft = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      }),
    });
    assert.equal(draft.status, 200);
    const grant = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        cardIds: ["card-one"],
        cardRevisions: [{ cardId: "card-one", revision: REVISION }],
        expiresAt: "2026-08-11T14:00:00.000Z",
      }),
    });
    assert.equal(grant.status, 200);
    assert.equal(callbacks.length, 2);
  } finally {
    await server.stop();
  }
});

test("owner HTTP derives a preset grant expiry from the server clock", async () => {
  const originalNow = Date.now;
  const serverNow = Date.parse("2026-08-11T12:00:00.000Z");
  let grantInput: Record<string, unknown> | undefined;
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateGrant: async (_principal: string, input: Record<string, unknown>) => {
      grantInput = input;
      return {
        grantId: "grant-one",
        secret: "s".repeat(43),
        expiresAt: input.expiresAt,
        version: 1,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
  });
  Date.now = () => serverNow;
  const { port } = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        cardIds: ["card-one"],
        cardRevisions: [{ cardId: "card-one", revision: REVISION }],
        durationMs: 1_800_000,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(grantInput?.expiresAt, "2026-08-11T12:30:00.000Z");
  } finally {
    Date.now = originalNow;
    await server.stop();
  }
});

test("owner HTTP applies the write quota to share-link revocation", async () => {
  const revocations: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async () => card(),
    supportPassportRevokeGrant: async (...args: unknown[]) => {
      revocations.push(args);
      return {
        grantId: "grant-one",
        revokedAt: "2026-08-11T12:05:00.000Z",
        version: 2,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: TOKEN,
    principal: "owner:alice",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
    writeRateLimitWindowMs: 60_000,
  });
  const { port } = await server.start();
  try {
    const draft = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      }),
    });
    assert.equal(draft.status, 200);
    const revoked = await fetch(`http://127.0.0.1:${port}/engram/v1/support-passport/grants/grant-one/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(revoked.status, 429);
    assert.equal(revocations.length, 0);
  } finally {
    await server.stop();
  }
});
