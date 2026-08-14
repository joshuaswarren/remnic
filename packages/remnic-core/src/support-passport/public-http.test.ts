import assert from "node:assert/strict";
import { type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { isAbortError } from "../abort-error.js";
import type { EngramAccessService } from "../access-service.js";
import {
  type SupportPassportPublicHandlerOptions,
  buildSupportPassportPublicRequestHandler,
} from "./index.js";
import { normalizeSupportPassportNetworkAddress } from "./public-http.js";

const SECRET = "s".repeat(43);
const GUIDE = {
  schemaVersion: 1 as const,
  grantId: "grant-one",
  expiresAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
  cards: [
    {
      cardId: "card-one",
      title: "Plan changes",
      statement: "Tell me before plans change.",
      category: "transitions" as const,
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
  ],
};

async function startPublicServer(
  service: EngramAccessService,
  onError: (error: unknown) => void = (error) => {
    throw error;
  },
  onRequest: () => void = () => {},
  handlerOptions: SupportPassportPublicHandlerOptions = {}
): Promise<{ server: Server; root: string }> {
  const handler = buildSupportPassportPublicRequestHandler(service, handlerOptions);
  const server = createServer((req, res) => {
    onRequest();
    void handler(req, res, { authorized: false }).catch((error) => {
      onError(error);
      if (!res.destroyed && !res.writableEnded) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, root: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("the standalone support passport entry registers its public operations", async () => {
  const service = {
    supportPassportReadGrant: async () => GUIDE,
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  try {
    const response = await fetch(`${root}/engram/v1/support-passport/public/grants/grant-one`, {
      headers: { authorization: `SupportPassport ${SECRET}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), GUIDE);
  } finally {
    await stopServer(server);
  }
});

test("a quota slot is reserved before a successful helper read", async () => {
  const lastReadStarted = Promise.withResolvers<void>();
  const releaseLastRead = Promise.withResolvers<void>();
  let reads = 0;
  const service = {
    supportPassportReadGrant: async () => {
      reads += 1;
      if (reads === 60) {
        lastReadStarted.resolve();
        await releaseLastRead.promise;
      }
      return GUIDE;
    },
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const url = `${root}/engram/v1/support-passport/public/grants/grant-one`;
  const headers = { authorization: `SupportPassport ${SECRET}` };
  try {
    for (let index = 0; index < 59; index += 1) {
      assert.equal((await fetch(url, { headers })).status, 200);
    }
    const admitted = fetch(url, { headers });
    await lastReadStarted.promise;
    const rejected = await fetch(url, { headers });
    assert.equal(rejected.status, 429);
    releaseLastRead.resolve();
    assert.equal((await admitted).status, 200);
    assert.equal(reads, 60);
  } finally {
    releaseLastRead.resolve();
    await stopServer(server);
  }
});

test("long helper answers use separate model capacity from guide reads", async () => {
  const allAnswersStarted = Promise.withResolvers<void>();
  const releaseAnswers = Promise.withResolvers<void>();
  let answerCalls = 0;
  const service = {
    supportPassportReadGrant: async () => GUIDE,
    supportPassportAskGrant: async () => {
      answerCalls += 1;
      if (answerCalls === 8) allAnswersStarted.resolve();
      await releaseAnswers.promise;
      return { answer: "The guide says to give advance notice." };
    },
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const askUrl = `${root}/engram/v1/support-passport/public/grants/grant-one/ask`;
  const headers = {
    authorization: `SupportPassport ${SECRET}`,
    "content-type": "application/json",
  };
  try {
    const asks = Array.from({ length: 8 }, (_, index) =>
      fetch(askUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: `Question ${index + 1}?` }),
      })
    );
    await allAnswersStarted.promise;

    const admittedRead = await fetch(`${root}/engram/v1/support-passport/public/grants/grant-one`, { headers });
    assert.equal(admittedRead.status, 200, "model work must not consume authentication capacity");
    const blockedAsk = await fetch(askUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "One more question?" }),
    });
    assert.equal(blockedAsk.status, 429, "model work must retain separate model capacity");
    assert.equal(answerCalls, 8);

    releaseAnswers.resolve();
    const responses = await Promise.all(asks);
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(8).fill(200)
    );
    const finalRead = await fetch(`${root}/engram/v1/support-passport/public/grants/grant-one`, { headers });
    assert.equal(finalRead.status, 200);
  } finally {
    releaseAnswers.resolve();
    await stopServer(server);
  }
});

test("slow helper bodies cannot bypass authentication capacity", async () => {
  const requestsStarted = Promise.withResolvers<void>();
  const unexpectedErrors: unknown[] = [];
  let requestCount = 0;
  const service = {
    supportPassportReadGrant: async () => GUIDE,
    supportPassportAskGrant: async () => ({ answer: "The guide says to give advance notice." }),
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(
    service,
    (error) => {
      if (!isAbortError(error)) unexpectedErrors.push(error);
    },
    () => {
      requestCount += 1;
      if (requestCount === 8) requestsStarted.resolve();
    }
  );
  const url = new URL(`${root}/engram/v1/support-passport/public/grants/grant-one/ask`);
  const slowClients = Array.from({ length: 8 }, () => {
    const client = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    client.on("error", () => {});
    client.flushHeaders();
    client.write('{"question":"partial');
    return client;
  });
  try {
    await requestsStarted.promise;
    const rejected = await new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
      const client = request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `SupportPassport ${SECRET}`,
          "content-type": "application/json",
          "content-length": "100",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve({
          status: response.statusCode,
          connection: response.headers.connection,
        }));
      });
      client.once("error", reject);
      client.flushHeaders();
      client.write('{"question":"partial');
    });
    assert.equal(rejected.status, 429);
    assert.equal(rejected.connection, "close");
  } finally {
    for (const client of slowClients) client.destroy();
    await stopServer(server);
  }
  assert.deepEqual(unexpectedErrors, []);
});

test("oversized helper questions close the unread request body", async () => {
  const service = {} as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const url = new URL(`${root}/engram/v1/support-passport/public/grants/grant-one/ask`);
  try {
    const response = await new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
      const client = request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `SupportPassport ${SECRET}`,
          "content-type": "application/json",
          "content-length": "10000",
        },
      }, (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve({
          status: incoming.statusCode,
          connection: incoming.headers.connection,
        }));
      });
      client.once("error", reject);
      client.flushHeaders();
      client.write(`{"question":"${"a".repeat(4_200)}`);
    });
    assert.equal(response.status, 400);
    assert.equal(response.connection, "close");
  } finally {
    await stopServer(server);
  }
});

test("public routes canonicalize grant IDs before service and quota use", async () => {
  const grantIds: string[] = [];
  const service = {
    supportPassportReadGrant: async (grantId: string) => {
      grantIds.push(grantId);
      return GUIDE;
    },
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  try {
    const response = await fetch(
      `${root}/engram/v1/support-passport/public/grants/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE`,
      { headers: { authorization: `SupportPassport ${SECRET}` } }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(grantIds, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  } finally {
    await stopServer(server);
  }
});

test("invalid helper credentials close an unread request body", async () => {
  const service = {} as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const url = new URL(`${root}/engram/v1/support-passport/public/grants/grant-one/ask`);
  const responseReceived = Promise.withResolvers<void>();
  const clientClosed = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  const client = request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "application/json",
        "content-length": "100",
      },
    },
    (response) => {
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers.connection, "close");
      response.resume();
      response.once("end", responseReceived.resolve);
    }
  );
  client.on("error", (error) => errors.push(error));
  client.once("close", clientClosed.resolve);
  client.flushHeaders();
  client.write('{"question":"partial');
  try {
    await Promise.race([
      Promise.all([responseReceived.promise, clientClosed.promise]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("unread helper request stayed open")), 2_000)),
    ]);
    assert.deepEqual(errors, []);
  } finally {
    client.destroy();
    await stopServer(server);
  }
});

test("malformed helper questions consume the network failure limit", async () => {
  let reads = 0;
  const service = {
    supportPassportReadGrant: async () => {
      reads += 1;
      return GUIDE;
    },
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const url = `${root}/engram/v1/support-passport/public/grants/grant-one/ask`;
  const headers = {
    authorization: `SupportPassport ${SECRET}`,
    "content-type": "application/json",
  };
  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(url, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 400);
    }
    const rejected = await fetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(rejected.status, 429);
    assert.equal(reads, 0);
  } finally {
    await stopServer(server);
  }
});

test("forwarded addresses cannot bypass the network failure limit", async () => {
  const service = {
    supportPassportReadGrant: async () => GUIDE,
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service);
  const url = `${root}/engram/v1/support-passport/public/grants/grant-one/ask`;
  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `SupportPassport ${SECRET}`,
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${index + 1}`,
        },
        body: "{}",
      });
      assert.equal(response.status, 400);
    }
    const rejected = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.200",
      },
      body: "{}",
    });
    assert.equal(rejected.status, 429);
  } finally {
    await stopServer(server);
  }
});

test("an explicit trusted proxy separates helper network limits", async () => {
  const service = {
    supportPassportReadGrant: async () => GUIDE,
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(
    service,
    undefined,
    undefined,
    { trustedProxyAddresses: ["127.0.0.1"] }
  );
  const url = `${root}/engram/v1/support-passport/public/grants/grant-one/ask`;
  const requestFrom = async (address: string) =>
    await fetch(url, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "x-forwarded-for": address,
      },
      body: "{}",
    });
  try {
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await requestFrom("198.51.100.10")).status, 400);
    }
    assert.equal((await requestFrom("198.51.100.10")).status, 429);
    assert.equal((await requestFrom("198.51.100.11")).status, 400);
  } finally {
    await stopServer(server);
  }
});

test("trusted proxy matching canonicalizes equivalent IPv6 addresses", () => {
  assert.equal(normalizeSupportPassportNetworkAddress("0:0:0:0:0:0:0:1"), "::1");
  assert.equal(normalizeSupportPassportNetworkAddress("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeSupportPassportNetworkAddress("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(normalizeSupportPassportNetworkAddress("0:0:0:0:0:ffff:c000:201"), "192.0.2.1");
});

test("a helper disconnect during the question body becomes an abort", async () => {
  const caught = Promise.withResolvers<unknown>();
  const requestStarted = Promise.withResolvers<void>();
  const service = {
    supportPassportReadGrant: async () => GUIDE,
    supportPassportAskGrant: async () => {
      throw new Error("the disconnected request reached the model");
    },
  } as unknown as EngramAccessService;
  const { server, root } = await startPublicServer(service, caught.resolve, requestStarted.resolve);
  try {
    const url = new URL(`${root}/engram/v1/support-passport/public/grants/grant-one/ask`);
    const client = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    client.on("error", () => {});
    client.flushHeaders();
    await requestStarted.promise;
    client.write('{"question":"partial');
    client.destroy();

    const error = await caught.promise;
    assert.equal(isAbortError(error), true);
  } finally {
    await stopServer(server);
  }
});
