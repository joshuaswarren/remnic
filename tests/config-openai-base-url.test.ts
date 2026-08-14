import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { initLogger, type LoggerBackend } from "../src/logger.js";

function withLoggerWarnings(): { warnings: string[] } {
  const warnings: string[] = [];
  const backend: LoggerBackend = {
    info() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    debug() {},
  };
  initLogger(backend, false);
  return { warnings };
}

test("openaiBaseUrl supports ${ENV_VAR} expansion from config", () => {
  const original = process.env.TEST_OPENAI_BASE_URL;
  process.env.TEST_OPENAI_BASE_URL = "https://api.example.test/v1";
  const { warnings } = withLoggerWarnings();

  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "${TEST_OPENAI_BASE_URL}",
  });

  assert.equal(cfg.openaiBaseUrl, "https://api.example.test/v1");
  assert.equal(warnings.length, 0);

  if (original === undefined) delete process.env.TEST_OPENAI_BASE_URL;
  else process.env.TEST_OPENAI_BASE_URL = original;
});

test("openaiBaseUrl falls back to OPENAI_BASE_URL when not set in config", () => {
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://fallback.example.test/v1";
  const { warnings } = withLoggerWarnings();

  const cfg = parseConfig({
    openaiApiKey: "sk-test",
  });

  assert.equal(cfg.openaiBaseUrl, "https://fallback.example.test/v1");
  assert.equal(warnings.length, 0);

  if (original === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = original;
});

test("openaiBaseUrl rejects malformed and unsupported environment values", () => {
  const original = process.env.OPENAI_BASE_URL;
  try {
    for (const value of ["   ", "not a URL", "ftp://provider.example.test/v1"]) {
      process.env.OPENAI_BASE_URL = value;
      assert.throws(
        () => parseConfig({ openaiApiKey: "sk-test" }),
        /OPENAI_BASE_URL must (?:be an absolute HTTP or HTTPS URL|use HTTP or HTTPS)/,
      );
    }
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
  }
});

test("openaiBaseUrl rejects unsupported schemes", () => {
  const { warnings } = withLoggerWarnings();
  assert.throws(
    () => parseConfig({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "ftp://provider.example.test/v1",
    }),
    /openaiBaseUrl must use HTTP or HTTPS/,
  );
  assert.equal(warnings.length, 0);
});

test("openaiBaseUrl rejects malformed configured URLs", () => {
  const { warnings } = withLoggerWarnings();
  assert.throws(
    () => parseConfig({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "not a URL",
    }),
    /openaiBaseUrl must be an absolute HTTP or HTTPS URL/,
  );
  assert.equal(warnings.length, 0);
});

test("openaiBaseUrl rejects a blank configured URL", () => {
  const { warnings } = withLoggerWarnings();
  for (const openaiBaseUrl of ["", "   "]) {
    assert.throws(
      () => parseConfig({
        openaiApiKey: "sk-test",
        openaiBaseUrl,
      }),
      /openaiBaseUrl must be an absolute HTTP or HTTPS URL/,
    );
  }
  assert.equal(warnings.length, 0);
});

test("openaiBaseUrl warns when using insecure http", () => {
  const { warnings } = withLoggerWarnings();
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "http://localhost:1234/v1",
  });

  assert.equal(cfg.openaiBaseUrl, "http://localhost:1234/v1");
  assert.ok(warnings.some((w) => w.includes("insecure http")));
});
