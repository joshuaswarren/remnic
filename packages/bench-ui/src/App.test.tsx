import assert from "node:assert/strict";
import test from "node:test";

import { fetchBenchResultsPayload, resolveBenchResultsUrl, resolveBenchResultsUrls } from "./App";

test("resolveBenchResultsUrl uses Vite base URL for subpath static deployments", () => {
  assert.equal(resolveBenchResultsUrl("/"), "/api/results");
  assert.equal(resolveBenchResultsUrl("/bench/"), "/bench/api/results");
  assert.equal(resolveBenchResultsUrl("/bench"), "/bench/api/results");
});

test("resolveBenchResultsUrl supports relative static deployments", () => {
  assert.equal(resolveBenchResultsUrl("./"), "api/results");
  assert.equal(resolveBenchResultsUrl("."), "api/results");
});

test("resolveBenchResultsUrl keeps dev server requests on the middleware route", () => {
  assert.equal(resolveBenchResultsUrl("/bench/", true), "/api/results");
});

test("resolveBenchResultsUrls falls back to preview middleware after the static asset URL", () => {
  assert.deepEqual(resolveBenchResultsUrls("/bench/"), ["/bench/api/results", "/api/results"]);
});

test("fetchBenchResultsPayload tries the middleware fallback after non-OK static asset responses", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const payload = { resultsDir: "preview", summaries: [], skippedFiles: [] };

  try {
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      if (requestedUrls.length === 1) {
        return new Response("missing", { status: 404 });
      }

      return Response.json(payload);
    };

    assert.deepEqual(await fetchBenchResultsPayload(["/bench/api/results", "/api/results"]), payload);
    assert.deepEqual(requestedUrls, ["/bench/api/results", "/api/results"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
