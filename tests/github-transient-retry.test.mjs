import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientGithubLookupError,
  withTransientGithubRetry,
} from "../scripts/github-transient-retry.mjs";

test("treats new-PR GraphQL node 404/422 as transient", () => {
  assert.equal(
    isTransientGithubLookupError({
      status: 404,
      message:
        'Not Found: {"type":"NOT_FOUND","message":"Could not resolve to a node with the global id of \'PR_kwDO\'."}',
    }),
    true,
  );
  assert.equal(
    isTransientGithubLookupError({
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [{ message: "Could not resolve to a node with the global id of 'PR_kwDO'." }],
        },
      },
    }),
    true,
  );
});

test("treats 429/502/503 as transient and leaves real 404s fatal", () => {
  assert.equal(isTransientGithubLookupError({ status: 429 }), true);
  assert.equal(isTransientGithubLookupError({ status: 502 }), true);
  assert.equal(isTransientGithubLookupError({ status: 503 }), true);
  assert.equal(
    isTransientGithubLookupError({ status: 404, message: "Not Found" }),
    false,
  );
});

test("retries transient lookups then returns the success value", async () => {
  const sleeps = [];
  let calls = 0;
  const result = await withTransientGithubRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("Could not resolve to a node");
        error.status = 404;
        throw error;
      }
      return "ok";
    },
    {
      attempts: 5,
      delayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

test("does not retry a non-transient error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTransientGithubRetry(
        async () => {
          calls += 1;
          const error = new Error("Not Found");
          error.status = 404;
          throw error;
        },
        { attempts: 4, delayMs: 10, sleep: async () => {} },
      ),
    /Not Found/,
  );
  assert.equal(calls, 1);
});
