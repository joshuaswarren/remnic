import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import type { SupportPassportModelJob, SupportPassportModelRoute } from "@remnic/core";
import { createDelegateSupportPassportModelService } from "./delegate-support-passport-model.js";

test("the delegate worker runs daemon jobs through the injected gateway route", async () => {
  const completion = Promise.withResolvers<Record<string, unknown>>();
  const job: SupportPassportModelJob = {
    id: "a871fab2-2f1c-478c-af4c-8c4a755d8072",
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
    assert.equal(completionAttempts, 2);
    assert.equal(posted.id, job.id);
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
