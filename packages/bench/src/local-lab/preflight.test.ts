import assert from "node:assert/strict";
import test from "node:test";

import {
  discoveryEndpointFor,
  modelMismatchReason,
  preflightLocalLabRole,
  type LocalLabPreflightInput,
} from "./preflight.ts";

/**
 * Stub fetch that responds with a fixed body + status. Captures the request
 * URL so tests can assert the discovery endpoint shape. Production talks to
 * the same `fetch` contract, so this stub matches the production signature
 * (rule 33 — no mock-only surface).
 */
function stubFetch(
  body: unknown,
  status = 200,
): { fetchImpl: typeof fetch; requests: URL[] } {
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (input, _init) => {
    requests.push(new URL(typeof input === "string" ? input : input.toString()));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, requests };
}

function failingFetch(error: Error): typeof fetch {
  return async () => {
    throw error;
  };
}

const responderInput: LocalLabPreflightInput = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "qwen3:14b",
  ctx: 16384,
};

test("discoveryEndpointFor appends /v1/models for openai-compatible baseUrl without /v1", () => {
  assert.equal(
    discoveryEndpointFor("openai-compatible", "http://localhost:8080"),
    "http://localhost:8080/v1/models",
  );
  assert.equal(
    discoveryEndpointFor("openai-compatible", "http://localhost:8080/v1"),
    "http://localhost:8080/v1/models",
  );
  // Tolerates a trailing slash on either form.
  assert.equal(
    discoveryEndpointFor("openai-compatible", "http://localhost:8080/v1/"),
    "http://localhost:8080/v1/models",
  );
});

test("discoveryEndpointFor appends /api/tags for ollama baseUrl without /api", () => {
  assert.equal(
    discoveryEndpointFor("ollama", "http://localhost:11434"),
    "http://localhost:11434/api/tags",
  );
  assert.equal(
    discoveryEndpointFor("ollama", "http://localhost:11434/api"),
    "http://localhost:11434/api/tags",
  );
});

test("preflight succeeds when the endpoint reports the manifest model id", async () => {
  const { fetchImpl, requests } = stubFetch({
    data: [
      { id: "qwen3:14b", context_length: 32768 },
      { id: "llama3:70b" },
    ],
  });
  const result = await preflightLocalLabRole(responderInput, {
    fetchImpl,
    timeoutMs: 1000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.endpoint, "http://127.0.0.1:8080/v1/models");
    assert.equal(result.expectedModel, "qwen3:14b");
    assert.equal(result.matchedContextLength, 32768);
    assert.equal(result.foundModels.length, 2);
  }
  assert.equal(requests.length, 1, "preflight must issue exactly one GET");
  assert.equal(requests[0].pathname, "/v1/models");
});

test("preflight failure surfaces the endpoint's ACTUAL model list (rule 51)", async () => {
  const { fetchImpl } = stubFetch({
    data: [{ id: "phi4:14b" }, { id: "llama3:8b" }, { id: "gemma3:27b" }],
  });
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });

  assert.equal(result.ok, false);
  if (!result.ok) {
    // The found model list MUST be present so the operator sees the mismatch.
    assert.equal(result.foundModels.length, 3);
    assert.deepEqual(
      result.foundModels.map((m) => m.id),
      ["phi4:14b", "llama3:8b", "gemma3:27b"],
    );
    // The reason text MUST enumerate the found models.
    assert.match(result.reason, /did not report the manifest model qwen3:14b/);
    assert.match(result.reason, /phi4:14b/);
    assert.match(result.reason, /llama3:8b/);
    assert.match(result.reason, /gemma3:27b/);
    // The expected model is also a top-level field on the failure object.
    assert.equal(result.expectedModel, "qwen3:14b");
  }
});

test("preflight truncates a large found-models list in the reason but keeps the full list in foundModels", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => ({ id: `model-${i}` }));
  const { fetchImpl } = stubFetch({ data: ids });
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.foundModels.length, 25, "foundModels keeps the full list");
    assert.match(result.reason, /\u2026/, "reason truncates with a \u2026 ellipsis");
  }
});

test("preflight reports an empty-found-list reason when endpoint returns no models", async () => {
  const { fetchImpl } = stubFetch({ data: [] });
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.foundModels.length, 0);
    assert.match(result.reason, /endpoint reported no models/);
  }
});

test("preflight fails when matched context length is below the manifest ctx", async () => {
  const { fetchImpl } = stubFetch({
    data: [{ id: "qwen3:14b", context_length: 8192 }],
  });
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(
      result.reason,
      /reports context length 8192 tokens which is below the manifest ctx 16384/,
    );
    assert.equal(result.matchedContextLength, 8192);
  }
});

test("preflight treats missing context_length as a pass (not all endpoints report it)", async () => {
  const { fetchImpl } = stubFetch({
    data: [{ id: "qwen3:14b" }],
  });
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });
  assert.equal(result.ok, true);
});

test("preflight surfaces a transport failure as a preflight result (not a thrown error)", async () => {
  const result = await preflightLocalLabRole(responderInput, {
    fetchImpl: failingFetch(new Error("ECONNREFUSED")),
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /ECONNREFUSED/);
    assert.match(result.reason, /http:\/\/127\.0\.0\.1:8080\/v1\/models/);
  }
});

test("preflight surfaces non-2xx HTTP responses with status + statusText", async () => {
  const { fetchImpl } = stubFetch({ error: "bad auth" }, 401);
  const result = await preflightLocalLabRole(responderInput, { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /HTTP 401/);
  }
});

test("preflight handles Ollama /api/tags shape ({ models: [{ name }] })", async () => {
  const { fetchImpl, requests } = stubFetch({
    models: [
      { name: "gemma3:27b", details: { parameter_size: "27B" } },
      { name: "qwen3:14b" },
    ],
  });
  const result = await preflightLocalLabRole(
    {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma3:27b",
      ctx: 16384,
    },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.endpoint, "http://127.0.0.1:11434/api/tags");
    assert.equal(result.foundModels.length, 2);
  }
  assert.equal(requests[0].pathname, "/api/tags");
});

test("preflight never interpolates baseUrl/model into anything but a fetch URL (rule 10)", async () => {
  // The stub captures the URL the preflight actually fetched; that URL must be
  // composed via string concatenation against `baseUrl` only — there is no
  // shell to leak into in this codepath at all.
  const { fetchImpl, requests } = stubFetch({ data: [{ id: "qwen3:14b" }] });
  await preflightLocalLabRole(responderInput, { fetchImpl });
  assert.equal(
    requests[0].toString(),
    "http://127.0.0.1:8080/v1/models",
    "preflight must hit the discovery endpoint only",
  );
});

test("modelMismatchReason helper formats both empty and populated lists", () => {
  assert.match(
    modelMismatchReason("foo", []),
    /endpoint reported no models; expected foo/,
  );
  assert.match(
    modelMismatchReason("foo", [{ id: "bar" }, { id: "baz" }]),
    /did not report the manifest model foo.*bar.*baz/,
  );
});
