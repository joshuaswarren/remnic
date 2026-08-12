import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { EngramAccessHttpServer, type EngramAccessService, SupportPassportError } from "@remnic/core";

const GRANT_ID = "grant-one";
const SECRET = "s".repeat(43);
const BASE_PATH = `/engram/v1/support-passport/public/grants/${GRANT_ID}`;

const guide = {
  schemaVersion: 1 as const,
  grantId: GRANT_ID,
  expiresAt: "2026-08-11T14:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  cards: [
    {
      cardId: "card-one",
      title: "Plan changes",
      statement: "Tell me before plans change.",
      category: "transitions" as const,
      updatedAt: "2026-08-11T12:00:00.000Z",
    },
  ],
};

async function startPublicServer(service: EngramAccessService) {
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "owner-token",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  return { server, origin: `http://127.0.0.1:${port}` };
}

function rawRequest(
  origin: string,
  path: string,
  options: { method: string; headers: Record<string, string>; body?: string; localAddress?: string }
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const req = request(
      target,
      { method: options.method, headers: options.headers, localAddress: options.localAddress },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.once("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      }
    );
    req.once("error", reject);
    req.end(options.body);
  });
}

test("public routes use only the custom secret header and never authorize generic routes", async () => {
  const reads: Array<[string, string]> = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async (grantId: string, secret: string) => {
      reads.push([grantId, secret]);
      if (secret !== SECRET) {
        throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
      }
      return guide;
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  try {
    const missing = await fetch(`${origin}${BASE_PATH}`);
    const bearer = await fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const wrong = await fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `SupportPassport ${"w".repeat(43)}` },
    });
    assert.equal(missing.status, 404);
    assert.equal(bearer.status, 404);
    assert.equal(wrong.status, 404);
    const missingBody = await missing.json();
    assert.deepEqual(await bearer.json(), missingBody);
    assert.deepEqual(await wrong.json(), missingBody);

    const response = await fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `SupportPassport ${SECRET}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Authorization");
    assert.deepEqual(await response.json(), guide);
    const lowercaseScheme = await fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `supportpassport ${SECRET}` },
    });
    assert.equal(lowercaseScheme.status, 200);
    assert.deepEqual(await lowercaseScheme.json(), guide);
    assert.deepEqual(reads, [
      [GRANT_ID, "w".repeat(43)],
      [GRANT_ID, SECRET],
      [GRANT_ID, SECRET],
    ]);

    const generic = await fetch(`${origin}/engram/v1/live`, {
      headers: { authorization: `SupportPassport ${SECRET}` },
    });
    assert.equal(generic.status, 401);
  } finally {
    await server.stop();
  }
});

test("public routes reject query and body secrets before service dispatch", async () => {
  let readCalls = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => {
      readCalls += 1;
      return guide;
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  try {
    const queried = await fetch(`${origin}${BASE_PATH}?secret=${SECRET}`, {
      headers: { authorization: `SupportPassport ${SECRET}` },
    });
    assert.equal(queried.status, 400);

    const body = JSON.stringify({ secret: SECRET });
    const withBody = await rawRequest(origin, BASE_PATH, {
      method: "GET",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(withBody.status, 400);
    assert.equal(readCalls, 0);
  } finally {
    await server.stop();
  }
});

test("public questions are bounded, grounded through core, and rate limited", async () => {
  const questions: string[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => guide,
    supportPassportAskGrant: async (_grantId: string, _secret: string, question: string) => {
      questions.push(question);
      return {
        answer: "Tell this person before plans change.",
        citedCardIds: ["card-one"],
        coverage: "grounded" as const,
      };
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const ask = (body: unknown) =>
    fetch(`${origin}${BASE_PATH}/ask`, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await ask({ question: "What helps?", namespace: "owner" })).status, 400);
    assert.equal(questions.length, 0);

    for (let index = 0; index < 20; index += 1) {
      const response = await ask({ question: `What helps ${index + 1}?` });
      assert.equal(response.status, 200);
    }
    const limited = await ask({ question: "One more question?" });
    assert.equal(limited.status, 429);
    assert.equal(questions.length, 20);
  } finally {
    await server.stop();
  }
});

test("an exhausted failure network stops authentication without consuming the shared question quota", async () => {
  let answers = 0;
  let reads = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async (_grantId: string, secret: string) => {
      reads += 1;
      if (secret !== SECRET) {
        throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
      }
      return guide;
    },
    supportPassportAskGrant: async () => {
      answers += 1;
      return { answer: "Use the guide.", citedCardIds: ["card-one"], coverage: "grounded" as const };
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const body = JSON.stringify({ question: "What helps?" });
  const ask = (secret: string, forwardedFor: string) =>
    rawRequest(origin, `${BASE_PATH}/ask`, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${secret}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-forwarded-for": forwardedFor,
      },
      body,
    });
  try {
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await ask("w".repeat(43), "198.51.100.1")).status, 404);
    }
    assert.equal((await ask(SECRET, "198.51.100.1")).status, 429);
    assert.equal(reads, 20);
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await ask(SECRET, "198.51.100.2")).status, 200);
    }
    assert.equal((await ask(SECRET, "198.51.100.2")).status, 429);
    assert.equal(reads, 40);
    assert.equal(answers, 20);
  } finally {
    await server.stop();
  }
});

test("loopback proxy clients keep separate quotas and exhausted grants do not charge network limits", async () => {
  let answers = 0;
  let reads = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async (_grantId: string, secret: string) => {
      reads += 1;
      if (secret !== SECRET) {
        throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
      }
      return guide;
    },
    supportPassportAskGrant: async () => {
      answers += 1;
      return { answer: "Use the guide.", citedCardIds: ["card-one"], coverage: "grounded" as const };
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const body = JSON.stringify({ question: "What helps?" });
  const ask = (grantId: string, forwardedFor: string) =>
    rawRequest(origin, `/engram/v1/support-passport/public/grants/${grantId}/ask`, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-forwarded-for": forwardedFor,
      },
      body,
    });
  try {
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await ask(GRANT_ID, `198.51.100.${index + 1}`)).status, 200);
    }
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await ask(GRANT_ID, "198.51.100.1")).status, 429);
    }
    assert.equal(reads, 20);
    assert.equal((await ask("grant-two", "198.51.100.1")).status, 200);
    assert.equal(reads, 21);
    assert.equal(answers, 21);
  } finally {
    await server.stop();
  }
});

test("loopback proxy quotas use the nearest untrusted forwarded address", async () => {
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => guide,
    supportPassportAskGrant: async () => ({
      answer: "Use the guide.",
      citedCardIds: ["card-one"],
      coverage: "grounded" as const,
    }),
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const body = JSON.stringify({ question: "What helps?" });
  const ask = (index: number) =>
    rawRequest(origin, `/engram/v1/support-passport/public/grants/grant-${index}/ask`, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-forwarded-for": `203.0.113.${index}, 198.51.100.50`,
      },
      body,
    });
  try {
    for (let index = 1; index <= 20; index += 1) {
      assert.equal((await ask(index)).status, 200);
    }
    assert.equal((await ask(21)).status, 429);
  } finally {
    await server.stop();
  }
});

test("an exhausted guide-read failure network stops authentication without consuming the grant quota", async () => {
  let reads = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async (_grantId: string, secret: string) => {
      reads += 1;
      if (secret !== SECRET) {
        throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
      }
      return guide;
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const read = (secret: string, forwardedFor: string) =>
    rawRequest(origin, BASE_PATH, {
      method: "GET",
      headers: {
        authorization: `SupportPassport ${secret}`,
        "x-forwarded-for": forwardedFor,
      },
    });
  try {
    for (let index = 0; index < 60; index += 1) {
      assert.equal((await read("w".repeat(43), "198.51.100.1")).status, 404);
    }
    assert.equal((await read(SECRET, "198.51.100.1")).status, 429);
    assert.equal(reads, 60);
    const freshNetwork = await read(SECRET, "198.51.100.2");
    assert.equal(freshNetwork.status, 200);
    assert.equal(reads, 61);
  } finally {
    await server.stop();
  }
});

test("concurrent invalid secrets cannot create unbounded grant reads", async () => {
  const releaseReads = Promise.withResolvers<void>();
  const eightReadsStarted = Promise.withResolvers<void>();
  let reads = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => {
      reads += 1;
      if (reads === 8) eightReadsStarted.resolve();
      await releaseReads.promise;
      throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const read = () =>
    fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `SupportPassport ${"w".repeat(43)}` },
    });
  try {
    const pending = Array.from({ length: 8 }, () => read());
    await eightReadsStarted.promise;
    const limited = await read();

    assert.equal(limited.status, 429);
    assert.equal(reads, 8);
    releaseReads.resolve();
    assert.deepEqual(
      await Promise.all(pending.map(async (response) => (await response).status)),
      Array.from({ length: 8 }, () => 404)
    );
  } finally {
    releaseReads.resolve();
    await server.stop();
  }
});

test("public questions release authentication capacity before model work", async () => {
  const releaseAnswers = Promise.withResolvers<void>();
  const eightAnswersStarted = Promise.withResolvers<void>();
  let answers = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => guide,
    supportPassportAskGrant: async () => {
      answers += 1;
      if (answers === 8) eightAnswersStarted.resolve();
      await releaseAnswers.promise;
      return { answer: "Use the guide.", citedCardIds: ["card-one"], coverage: "grounded" as const };
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  const ask = () =>
    fetch(`${origin}${BASE_PATH}/ask`, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "What helps?" }),
    });
  try {
    const pending = Array.from({ length: 8 }, () => ask());
    await eightAnswersStarted.promise;
    const read = await fetch(`${origin}${BASE_PATH}`, {
      headers: { authorization: `SupportPassport ${SECRET}` },
    });

    assert.equal(read.status, 200);
    assert.equal(answers, 8);
    releaseAnswers.resolve();
    assert.deepEqual(
      await Promise.all(pending.map(async (response) => (await response).status)),
      Array.from({ length: 8 }, () => 200)
    );
  } finally {
    releaseAnswers.resolve();
    await server.stop();
  }
});

test("the public handler aborts model work when the helper leaves", async () => {
  const invoked = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<boolean>();
  const service = {
    supportPassportEnabled: true,
    supportPassportReadGrant: async () => guide,
    supportPassportAskGrant: async (_grantId: string, _secret: string, _question: string, signal?: AbortSignal) => {
      invoked.resolve();
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted.resolve(signal.reason instanceof Error && signal.reason.name === "AbortError");
            reject(signal.reason);
          },
          { once: true }
        );
      });
    },
  } as unknown as EngramAccessService;
  const { server, origin } = await startPublicServer(service);
  try {
    const target = new URL(`${BASE_PATH}/ask`, origin);
    const req = request(target, {
      method: "POST",
      headers: {
        authorization: `SupportPassport ${SECRET}`,
        "content-type": "application/json",
      },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ question: "What helps?" }));
    await invoked.promise;
    req.destroy();
    assert.equal(await aborted.promise, true);
  } finally {
    await server.stop();
  }
});
