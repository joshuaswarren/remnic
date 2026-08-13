import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import type { SupportPassportModelJob, SupportPassportModelRoute } from "@remnic/core";
import {
  createDelegateSupportPassportModelService,
  supportPassportModelPollRetryDelayMs,
} from "./delegate-support-passport-model.js";

test("persistent delegate poll failures use capped exponential backoff", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 30].map(supportPassportModelPollRetryDelayMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
  );
});

test("the delegate worker runs daemon jobs through the injected gateway route", async () => {
  const completion = Promise.withResolvers<Record<string, unknown>>();
  const job: SupportPassportModelJob = {
    id: "a871fab2-2f1c-478c-af4c-8c4a755d8072",
    claimId: "b871fab2-2f1c-478c-af4c-8c4a755d8073",
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: JSON.stringify({ sourceNotes: [{ memoryId: "memory-1" }] }) },
    ],
    temperature: 0.2,
    maxTokens: 500,
    timeoutMs: 5_000,
    operation: "support-passport-draft",
    jsonSchema: { name: "drafts", schema: { type: "object" } },
  };
  let served = false;
  let acknowledged = false;
  let acknowledgeStartedAt = 0;
  let invokeStartedAt = 0;
  let completionAttempts = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer daemon-token");
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/jobs/next")) {
        if (!served) {
          served = true;
          res.end(JSON.stringify(job));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }
      if (req.url?.endsWith("/jobs/ack")) {
        acknowledgeStartedAt = Date.now();
        const claim = JSON.parse(raw) as { id: string; claimId: string };
        acknowledged = claim.id === job.id && claim.claimId === job.claimId;
        setTimeout(() => {
          res.statusCode = 204;
          res.end();
        }, 30);
        return;
      }
      completionAttempts += 1;
      if (completionAttempts === 1) {
        res.statusCode = 503;
        res.end();
        return;
      }
      completion.resolve(JSON.parse(raw) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  let accepted = false;
  const route: SupportPassportModelRoute = {
    kind: "gateway",
    invoke: async (_messages, options) => {
      invokeStartedAt = Date.now();
      assert.equal(acknowledged, true);
      assert.ok(options.timeoutMs <= job.timeoutMs - 20);
      const result = {
        content: JSON.stringify({
          cards: [
            {
              title: "Plan changes",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: ["memory-1"],
            },
          ],
        }),
        modelUsed: "gateway/local",
      };
      accepted = options.acceptResponse?.(result) === true;
      return result;
    },
  };
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route,
  });
  try {
    await service.start();
    const posted = await completion.promise;
    assert.equal(accepted, true);
    assert.ok(invokeStartedAt - acknowledgeStartedAt >= 20);
    assert.equal(completionAttempts, 2);
    assert.equal(posted.id, job.id);
    assert.equal(posted.claimId, job.claimId);
    assert.deepEqual(posted.result, {
      content: JSON.stringify({
        cards: [
          {
            title: "Plan changes",
            statement: "Tell me before plans change.",
            category: "transitions",
            sourceMemoryIds: ["memory-1"],
          },
        ],
      }),
      modelUsed: "gateway/local",
    });
  } finally {
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the delegate retries an ambiguous acknowledgement before the claim deadline", async () => {
  const completion = Promise.withResolvers<Record<string, unknown>>();
  const job: SupportPassportModelJob = {
    id: "f871fab2-2f1c-478c-af4c-8c4a755d8077",
    claimId: "f871fab2-2f1c-478c-af4c-8c4a755d8078",
    claimAckTimeoutMs: 4_000,
    messages: [{ role: "user", content: "What helps?" }],
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 5_000,
    operation: "support-passport-answer",
    jsonSchema: { name: "answer", schema: { type: "object" } },
  };
  let served = false;
  let acknowledgements = 0;
  let invoked = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      if (req.url?.endsWith("/jobs/next")) {
        if (!served) {
          served = true;
          res.end(JSON.stringify(job));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }
      if (req.url?.endsWith("/jobs/ack")) {
        acknowledgements += 1;
        if (acknowledgements === 1) {
          req.socket.destroy();
          return;
        }
        res.statusCode = 204;
        res.end();
        return;
      }
      completion.resolve(JSON.parse(raw) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: {
      kind: "gateway",
      invoke: async () => {
        invoked += 1;
        return { content: "{}", modelUsed: "gateway/local" };
      },
    },
  });
  try {
    await service.start();
    assert.deepEqual(await completion.promise, {
      id: job.id,
      claimId: job.claimId,
      result: { content: "{}", modelUsed: "gateway/local" },
    });
    assert.equal(acknowledgements, 2);
    assert.equal(invoked, 1);
  } finally {
    await service.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("delegate pollers run overlapping gateway jobs concurrently", async () => {
  const jobs = ["a871fab2-2f1c-478c-af4c-8c4a755d8072", "b871fab2-2f1c-478c-af4c-8c4a755d8073"].map(
    (id): SupportPassportModelJob => ({
      id,
      messages: [{ role: "user", content: id }],
      temperature: 0,
      maxTokens: 100,
      timeoutMs: 5_000,
      operation: "support-passport-answer",
      jsonSchema: { name: "answer", schema: { type: "object" } },
    })
  );
  const completions: string[] = [];
  const bothStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondCompleted = Promise.withResolvers<void>();
  let nextJob = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/jobs/next")) {
        const job = jobs[nextJob];
        nextJob += 1;
        if (job) res.end(JSON.stringify(job));
        else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }
      const body = JSON.parse(raw) as { id: string };
      completions.push(body.id);
      if (body.id === jobs[1]?.id) secondCompleted.resolve();
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  let started = 0;
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: {
      kind: "gateway",
      invoke: async (messages) => {
        started += 1;
        if (started === 2) bothStarted.resolve();
        if (messages[0]?.content === jobs[0]?.id) await releaseFirst.promise;
        return { content: "{}", modelUsed: "gateway/local" };
      },
    },
  });
  try {
    await service.start();
    await bothStarted.promise;
    await secondCompleted.promise;
    assert.deepEqual(completions, [jobs[1]?.id]);
    releaseFirst.resolve();
  } finally {
    releaseFirst.resolve();
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a claimed job uses the daemon's remaining duration without a shared wall clock", async () => {
  const completion = Promise.withResolvers<Record<string, unknown>>();
  const invoked = Promise.withResolvers<number>();
  const job: SupportPassportModelJob = {
    id: "e871fab2-2f1c-478c-af4c-8c4a755d8076",
    messages: [{ role: "user", content: "What helps?" }],
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1_900,
    operation: "support-passport-answer",
    jsonSchema: { name: "answer", schema: { type: "object" } },
  };
  let served = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      if (req.url?.endsWith("/jobs/next")) {
        if (!served) {
          served = true;
          setTimeout(() => res.end(JSON.stringify(job)), 100);
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }
      completion.resolve(JSON.parse(raw) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: {
      kind: "gateway",
      invoke: async (_messages, options) => {
        invoked.resolve(options.timeoutMs);
        return { content: "{}", modelUsed: "gateway/local" };
      },
    },
  });
  try {
    await service.start();
    const remainingMs = await invoked.promise;
    assert.ok(remainingMs > 0);
    assert.ok(remainingMs <= job.timeoutMs);
    assert.deepEqual(await completion.promise, {
      id: job.id,
      result: { content: "{}", modelUsed: "gateway/local" },
    });
  } finally {
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("delegate poll requests retry after their request timeout", async () => {
  const retried = Promise.withResolvers<void>();
  let requests = 0;
  const server = http.createServer((_req, _res) => {
    requests += 1;
    if (requests > 4) retried.resolve();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: { kind: "gateway", invoke: async () => null },
    requestTimeoutMs: 20,
  });
  try {
    await service.start();
    await Promise.race([
      retried.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("delegate poll did not retry")), 2_000)),
    ]);
  } finally {
    await service.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("delegate shutdown stops transient completion retries", async () => {
  const firstCompletion = Promise.withResolvers<void>();
  const job: SupportPassportModelJob = {
    id: "d871fab2-2f1c-478c-af4c-8c4a755d8075",
    messages: [{ role: "user", content: "What helps?" }],
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 5_000,
    operation: "support-passport-answer",
    jsonSchema: { name: "answer", schema: { type: "object" } },
  };
  let served = false;
  let completionAttempts = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/jobs/next")) {
        if (!served) {
          served = true;
          res.end(JSON.stringify(job));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }
      completionAttempts += 1;
      firstCompletion.resolve();
      res.statusCode = 503;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: { kind: "gateway", invoke: async () => ({ content: "{}", modelUsed: "gateway/local" }) },
  });
  try {
    await service.start();
    await firstCompletion.promise;
    await Promise.race([
      service.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("delegate shutdown did not stop retries")), 500)),
    ]);
    assert.equal(completionAttempts, 1);
  } finally {
    await service.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("delegate shutdown settles a claimed job before the worker stops", async () => {
  const job: SupportPassportModelJob = {
    id: "c871fab2-2f1c-478c-af4c-8c4a755d8074",
    messages: [{ role: "user", content: "What helps?" }],
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 5_000,
    operation: "support-passport-answer",
    jsonSchema: { name: "answer", schema: { type: "object" } },
  };
  const claimed = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<Record<string, unknown>>();
  let served = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/jobs/next")) {
        if (served) {
          res.statusCode = 204;
          res.end();
        } else {
          served = true;
          res.end(JSON.stringify(job));
        }
        return;
      }
      completion.resolve(JSON.parse(raw) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const service = createDelegateSupportPassportModelService({
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port: address.port,
      resolveAuthToken: () => ({ token: "daemon-token", source: "REMNIC_AUTH_TOKEN" }),
    },
    route: {
      kind: "gateway",
      invoke: async () => {
        claimed.resolve();
        return await new Promise(() => {});
      },
    },
  });
  try {
    await service.start();
    await claimed.promise;
    const stopped = service.stop();
    assert.deepEqual(await completion.promise, { id: job.id, result: null });
    await stopped;
  } finally {
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
