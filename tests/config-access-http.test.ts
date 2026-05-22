import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets local HTTP access defaults", () => {
  const originalRemnic = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  const originalRemnicPrincipal = process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
  const originalPrincipal = process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  try {
    const cfg = parseConfig({ openaiApiKey: "sk-test" });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: false,
      host: "127.0.0.1",
      port: 4318,
      authToken: undefined,
      principal: undefined,
      maxBodyBytes: 131072,
    });
  } finally {
    if (originalRemnic === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = originalRemnic;
    }
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
    if (originalPrincipal === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = originalPrincipal;
    }
    if (originalRemnicPrincipal === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL = originalRemnicPrincipal;
    }
  }
});

test("parseConfig supports explicit local HTTP access config and env fallback", () => {
  const originalRemnic = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  const originalRemnicPrincipal = process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
  const originalPrincipal = process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = "remnic-env-token";
  process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = "engram-env-token";
  process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL = "remnic-env-principal";
  process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = "env-principal";
  process.env.ENGRAM_ACCESS_TEST_TOKEN = "config-token";
  process.env.ENGRAM_ACCESS_TEST_PRINCIPAL = "config-principal";
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
        host: "localhost",
        port: 0,
        authToken: "${ENGRAM_ACCESS_TEST_TOKEN}",
        principal: "${ENGRAM_ACCESS_TEST_PRINCIPAL}",
        maxBodyBytes: 2048,
      },
    });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: true,
      host: "localhost",
      port: 0,
      authToken: "config-token",
      principal: "config-principal",
      maxBodyBytes: 2048,
    });

    const envCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(envCfg.agentAccessHttp.authToken, "remnic-env-token");
    assert.equal(envCfg.agentAccessHttp.principal, "remnic-env-principal");

    delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
    const legacyEnvCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(legacyEnvCfg.agentAccessHttp.authToken, "engram-env-token");
    assert.equal(legacyEnvCfg.agentAccessHttp.principal, "env-principal");
  } finally {
    delete process.env.ENGRAM_ACCESS_TEST_TOKEN;
    delete process.env.ENGRAM_ACCESS_TEST_PRINCIPAL;
    if (originalRemnic === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = originalRemnic;
    }
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
    if (originalPrincipal === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = originalPrincipal;
    }
    if (originalRemnicPrincipal === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL = originalRemnicPrincipal;
    }
  }
});

test("parseConfig prefers remnic access principal env over legacy OpenClaw principal", () => {
  const originalRemnicPrincipal = process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
  const originalPrincipal = process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL = "reader";
  process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = "legacy-reader";
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });

    assert.equal(cfg.agentAccessHttp.principal, "reader");

    delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
    const legacyCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(legacyCfg.agentAccessHttp.principal, "legacy-reader");
  } finally {
    if (originalRemnicPrincipal === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_PRINCIPAL = originalRemnicPrincipal;
    }
    if (originalPrincipal === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = originalPrincipal;
    }
  }
});

test("parseConfig preserves SecretRef authToken object verbatim (issue #757)", () => {
  const originalRemnic = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const secretRef = {
      source: "exec",
      provider: "kc_openclaw_remnic_token",
      id: "value",
    };
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
        authToken: secretRef,
      },
    });
    // SecretRef must NOT be coerced or stringified — runtime resolution
    // happens inside resolveAgentAccessAuthToken() at service-start time.
    assert.deepEqual(cfg.agentAccessHttp.authToken, secretRef);
  } finally {
    if (originalRemnic === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = originalRemnic;
    }
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
  }
});

test("parseConfig rejects non-string non-SecretRef authToken shapes (issue #757)", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        agentAccessHttp: { enabled: true, authToken: 12345 as unknown as string },
      }),
    /unsupported SecretRef shape/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        agentAccessHttp: {
          enabled: true,
          authToken: { provider: "no-source-field" } as unknown as string,
        },
      }),
    /unsupported SecretRef shape/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        agentAccessHttp: {
          enabled: true,
          authToken: { source: "   " } as unknown as string,
        },
      }),
    /unsupported SecretRef shape/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        agentAccessHttp: {
          enabled: true,
          authToken: ["not", "an", "object"] as unknown as string,
        },
      }),
    /unsupported SecretRef shape/,
  );
});

test("parseConfig preserves small explicit HTTP body limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    agentAccessHttp: {
      enabled: true,
      maxBodyBytes: 32,
    },
  });
  assert.equal(cfg.agentAccessHttp.maxBodyBytes, 32);
});
