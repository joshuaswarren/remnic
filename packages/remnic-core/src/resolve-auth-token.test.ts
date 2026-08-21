import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAuthTokenSecretCache,
  isAgentAccessSecretRef,
  resolveAgentAccessAuthToken,
} from "./resolve-auth-token.js";

test("resolveAgentAccessAuthToken passes through plain strings", async () => {
  clearAuthTokenSecretCache();
  const result = await resolveAgentAccessAuthToken("plain-bearer-token");
  assert.equal(result, "plain-bearer-token");
});

test("resolveAgentAccessAuthToken trims surrounding whitespace", async () => {
  clearAuthTokenSecretCache();
  const result = await resolveAgentAccessAuthToken("  spaced-token  ");
  assert.equal(result, "spaced-token");
});

test("resolveAgentAccessAuthToken returns undefined for empty / undefined input", async () => {
  clearAuthTokenSecretCache();
  assert.equal(await resolveAgentAccessAuthToken(undefined), undefined);
  assert.equal(await resolveAgentAccessAuthToken(""), undefined);
  assert.equal(await resolveAgentAccessAuthToken("   "), undefined);
});

test("resolveAgentAccessAuthToken delegates SecretRef objects to gateway resolver", async () => {
  clearAuthTokenSecretCache();
  const calls: unknown[] = [];
  const resolveSecretRef = async (ref: any) => {
    calls.push(ref);
    return "resolved-secret-value";
  };

  try {
    const result = await resolveAgentAccessAuthToken(
      {
        source: "exec",
        provider: "kc_openclaw_remnic_token",
        id: "value",
      },
      { resolveSecretRef },
    );
    assert.equal(result, "resolved-secret-value");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      source: "exec",
      provider: "kc_openclaw_remnic_token",
      id: "value",
    });
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken trims SecretRef resolver output", async () => {
  clearAuthTokenSecretCache();

  try {
    const result = await resolveAgentAccessAuthToken(
      {
        source: "exec",
        provider: "kc_openclaw_remnic_token",
        id: "value",
      },
      { resolveSecretRef: async () => "  resolved-secret-value\n" },
    );
    assert.equal(result, "resolved-secret-value");
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken caches resolved SecretRef values", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  const resolveSecretRef = async () => {
    callCount += 1;
    return "cached-token";
  };

  try {
    const ref = { source: "exec", provider: "kc_x", id: "value" };
    const first = await resolveAgentAccessAuthToken(ref, { resolveSecretRef });
    const second = await resolveAgentAccessAuthToken(ref, { resolveSecretRef });
    // Same shape but different object reference — should still hit cache
    const third = await resolveAgentAccessAuthToken({ ...ref }, { resolveSecretRef });
    assert.equal(first, "cached-token");
    assert.equal(second, "cached-token");
    assert.equal(third, "cached-token");
    assert.equal(callCount, 1);
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken cache key is order-independent", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  const resolveSecretRef = async () => {
    callCount += 1;
    return "stable-token";
  };

  try {
    await resolveAgentAccessAuthToken(
      { source: "exec", provider: "p", id: "v" },
      { resolveSecretRef },
    );
    await resolveAgentAccessAuthToken(
      { id: "v", provider: "p", source: "exec" },
      { resolveSecretRef },
    );
    assert.equal(callCount, 1, "key sort should make order-permuted refs share a cache slot");
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken scopes SecretRef cache by resolver function", async () => {
  clearAuthTokenSecretCache();
  let resolverACalls = 0;
  let resolverBCalls = 0;
  const resolverA = async () => {
    resolverACalls += 1;
    return "token-a";
  };
  const resolverB = async () => {
    resolverBCalls += 1;
    return "token-b";
  };

  try {
    const ref = { source: "exec", provider: "shared", id: "value" };
    const first = await resolveAgentAccessAuthToken(ref, { resolveSecretRef: resolverA });
    const second = await resolveAgentAccessAuthToken(ref, { resolveSecretRef: resolverB });
    const third = await resolveAgentAccessAuthToken({ ...ref }, { resolveSecretRef: resolverB });

    assert.equal(first, "token-a");
    assert.equal(second, "token-b");
    assert.equal(third, "token-b");
    assert.equal(resolverACalls, 1);
    assert.equal(resolverBCalls, 1);
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken throws when no SecretRef resolver is provided", async () => {
  clearAuthTokenSecretCache();

  await assert.rejects(
    () =>
      resolveAgentAccessAuthToken({
        source: "exec",
        provider: "kc_x",
        id: "value",
      }),
    /SecretRef resolver was not provided|cannot resolve/i,
  );
});

test("resolveAgentAccessAuthToken throws on missing source field", async () => {
  clearAuthTokenSecretCache();
  await assert.rejects(
    () =>
      resolveAgentAccessAuthToken({
        provider: "no-source-field",
      } as unknown as Parameters<typeof resolveAgentAccessAuthToken>[0]),
    /missing required `source` field/,
  );
  await assert.rejects(
    () =>
      resolveAgentAccessAuthToken({
        source: "   ",
      } as unknown as Parameters<typeof resolveAgentAccessAuthToken>[0]),
    /missing required `source` field/,
  );
});

test("resolveAgentAccessAuthToken throws when SecretRef resolves to empty string", async () => {
  clearAuthTokenSecretCache();
  try {
    await assert.rejects(
      () =>
        resolveAgentAccessAuthToken(
          {
            source: "exec",
            provider: "kc_x",
            id: "value",
          },
          { resolveSecretRef: async () => "" },
        ),
      /resolved to empty value/,
    );
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken surfaces resolver errors with context", async () => {
  clearAuthTokenSecretCache();
  const resolveSecretRef = async () => {
    throw new Error("keychain locked");
  };
  try {
    await assert.rejects(
      () =>
        resolveAgentAccessAuthToken(
          {
            source: "exec",
            provider: "kc_x",
            id: "value",
          },
          { resolveSecretRef },
        ),
      /failed to resolve.*SecretRef.*keychain locked/,
    );
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken does not cache failed resolutions", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  const resolveSecretRef = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("transient");
    return "second-try-success";
  };
  try {
    const ref = { source: "exec", provider: "kc_x", id: "value" };
    await assert.rejects(() => resolveAgentAccessAuthToken(ref, { resolveSecretRef }));
    const second = await resolveAgentAccessAuthToken(ref, { resolveSecretRef });
    assert.equal(second, "second-try-success");
    assert.equal(callCount, 2);
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("isAgentAccessSecretRef recognizes SecretRef shapes", () => {
  assert.equal(isAgentAccessSecretRef({ source: "exec", provider: "x" }), true);
  assert.equal(isAgentAccessSecretRef({ source: "env" }), true);
  assert.equal(isAgentAccessSecretRef("plain-string"), false);
  assert.equal(isAgentAccessSecretRef(undefined), false);
  assert.equal(isAgentAccessSecretRef(null), false);
  assert.equal(isAgentAccessSecretRef({}), false);
  assert.equal(isAgentAccessSecretRef({ source: "" }), false);
  assert.equal(isAgentAccessSecretRef({ source: "   " }), false);
  assert.equal(isAgentAccessSecretRef([1, 2, 3]), false);
});
