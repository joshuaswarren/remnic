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
          cards: [{
            title: "Plan changes",
            statement: "Tell me before plans change.",
            category: "transitions",
            sourceMemoryIds: ["memory-1"],
          }],
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
    assert.equal(posted.id, job.id);
    assert.deepEqual(posted.result, {
      content: JSON.stringify({
        cards: [{
          title: "Plan changes",
          statement: "Tell me before plans change.",
          category: "transitions",
          sourceMemoryIds: ["memory-1"],
        }],
      }),
      modelUsed: "gateway/local",
    });
  } finally {
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
