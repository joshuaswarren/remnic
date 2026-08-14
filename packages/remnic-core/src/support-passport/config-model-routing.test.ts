import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";

function withOpenaiBaseUrl(value: string, run: () => void): void {
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = value;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
  }
}

test("disabled direct models ignore an ambient OpenAI endpoint", () => {
  withOpenaiBaseUrl("not-an-absolute-url", () => {
    const config = parseConfig({
      openaiApiKey: false,
      localLlmEnabled: true,
    });

    assert.equal(config.openaiApiKey, undefined);
    assert.equal(config.openaiBaseUrl, undefined);
    assert.equal(config.localLlmEnabled, true);
  });
});

test("direct models still validate an ambient OpenAI endpoint", () => {
  withOpenaiBaseUrl("not-an-absolute-url", () => {
    assert.throws(
      () => parseConfig({ openaiApiKey: "fixture-key" }),
      /OPENAI_BASE_URL must be an absolute HTTP or HTTPS URL/,
    );
  });
});
