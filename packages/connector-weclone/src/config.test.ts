import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, DEFAULT_CONFIG } from "./config.js";

describe("parseConfig", () => {
  const validRaw = {
    wecloneApiUrl: "http://localhost:8000/v1",
    proxyPort: 8100,
    remnicDaemonUrl: "http://localhost:4318",
  };

  it("parses a valid minimal config and applies defaults", () => {
    const config = parseConfig(validRaw);
    assert.equal(config.wecloneApiUrl, "http://localhost:8000/v1");
    assert.equal(config.proxyPort, 8100);
    assert.equal(config.proxyBindHost, "127.0.0.1");
    assert.equal(config.allowPublicBind, false);
    assert.equal(config.remnicDaemonUrl, "http://localhost:4318");
    assert.equal(config.sessionStrategy, DEFAULT_CONFIG.sessionStrategy);
    assert.equal(config.wecloneModelName, DEFAULT_CONFIG.wecloneModelName);
    assert.deepStrictEqual(config.memoryInjection, DEFAULT_CONFIG.memoryInjection);
  });

  it("parses a fully specified config", () => {
    const full = {
      ...validRaw,
      wecloneModelName: "custom-avatar",
      sessionStrategy: "caller-id",
      memoryInjection: {
        maxTokens: 2000,
        position: "system-prepend",
        template: "MEMORIES:\n{memories}",
      },
    };
    const config = parseConfig(full);
    assert.equal(config.wecloneModelName, "custom-avatar");
    assert.equal(config.sessionStrategy, "caller-id");
    assert.equal(config.memoryInjection.maxTokens, 2000);
    assert.equal(config.memoryInjection.position, "system-prepend");
    assert.equal(config.memoryInjection.template, "MEMORIES:\n{memories}");
  });

  it("rejects null input", () => {
    assert.throws(() => parseConfig(null), /non-null object/);
  });

  it("rejects non-object input", () => {
    assert.throws(() => parseConfig("string"), /non-null object/);
  });

  it("rejects missing wecloneApiUrl", () => {
    const { wecloneApiUrl: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /wecloneApiUrl/);
  });

  it("rejects empty wecloneApiUrl", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, wecloneApiUrl: "" }),
      /wecloneApiUrl/
    );
  });

  it("rejects missing proxyPort", () => {
    const { proxyPort: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /proxyPort/);
  });

  it("rejects non-integer proxyPort", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 3.14 }),
      /proxyPort/
    );
  });

  it("rejects zero proxyPort", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 0 }),
      /proxyPort/
    );
  });

  it("rejects proxyPort above 65535", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 70000 }),
      /proxyPort.*between 1 and 65535/
    );
  });

  it("rejects proxyPort of 65536", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 65536 }),
      /proxyPort/
    );
  });

  it("accepts proxyPort at upper boundary (65535)", () => {
    const config = parseConfig({ ...validRaw, proxyPort: 65535 });
    assert.equal(config.proxyPort, 65535);
  });

  it("accepts proxyPort at lower boundary (1)", () => {
    const config = parseConfig({ ...validRaw, proxyPort: 1 });
    assert.equal(config.proxyPort, 1);
  });

  it("rejects all-interface proxy bind hosts without explicit opt-in", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyBindHost: "0.0.0.0" }),
      /allowPublicBind/,
    );
    assert.throws(
      () => parseConfig({ ...validRaw, proxyBindHost: "::" }),
      /allowPublicBind/,
    );
  });

  it("accepts all-interface proxy bind hosts with explicit opt-in", () => {
    const config = parseConfig({
      ...validRaw,
      proxyBindHost: "0.0.0.0",
      allowPublicBind: true,
    });
    assert.equal(config.proxyBindHost, "0.0.0.0");
    assert.equal(config.allowPublicBind, true);
  });

  it("rejects missing remnicDaemonUrl", () => {
    const { remnicDaemonUrl: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /remnicDaemonUrl/);
  });

  it("rejects invalid sessionStrategy", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, sessionStrategy: "round-robin" }),
      /sessionStrategy.*must be one of/
    );
  });

  it("rejects invalid memoryInjection.position", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { position: "middle" },
        }),
      /memoryInjection\.position.*must be one of/
    );
  });

  it("rejects non-object memoryInjection", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, memoryInjection: "bad" }),
      /memoryInjection.*must be an object/
    );
  });

  it("rejects non-positive memoryInjection.maxTokens", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { maxTokens: -1 },
        }),
      /maxTokens.*positive integer/
    );
  });

  it("rejects empty memoryInjection.template", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { template: "" },
        }),
      /template.*non-empty string/
    );
  });

  it("accepts remnicAuthToken as optional string", () => {
    const config = parseConfig({
      ...validRaw,
      remnicAuthToken: "my-secret-token",
    });
    assert.equal(config.remnicAuthToken, "my-secret-token");
  });

  it("omits remnicAuthToken when not provided", () => {
    const config = parseConfig(validRaw);
    assert.equal(config.remnicAuthToken, undefined);
  });

  it("rejects empty remnicAuthToken", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, remnicAuthToken: "" }),
      /remnicAuthToken.*non-empty string/
    );
  });

  it("rejects non-string remnicAuthToken", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, remnicAuthToken: 12345 }),
      /remnicAuthToken.*non-empty string/
    );
  });
});
