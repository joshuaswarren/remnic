import assert from "node:assert/strict";
import test from "node:test";

import { chatgptReplayNormalizer } from "./chatgpt.js";
import { claudeReplayNormalizer } from "./claude.js";
import { openclawReplayNormalizer } from "./openclaw.js";

test("replay normalizers throw on malformed whole-file JSON in strict mode", () => {
  assert.throws(
    () => chatgptReplayNormalizer.parse("{", { strict: true }),
    /Invalid ChatGPT replay JSON/,
  );
  assert.throws(
    () => claudeReplayNormalizer.parse("{", { strict: true }),
    /Invalid Claude replay JSON/,
  );
  assert.throws(
    () => openclawReplayNormalizer.parse("{bad jsonl}", { strict: true }),
    /invalid JSONL line/i,
  );
});

test("replay normalizers warn on malformed whole-file JSON outside strict mode", async () => {
  const chatgpt = await chatgptReplayNormalizer.parse("{");
  const claude = await claudeReplayNormalizer.parse("{");
  const openclaw = await openclawReplayNormalizer.parse("{bad jsonl}");

  assert.equal(
    chatgpt.warnings.some((warning) =>
      warning.code === "replay.chatgpt.json.invalid",
    ),
    true,
  );
  assert.equal(
    claude.warnings.some((warning) =>
      warning.code === "replay.claude.json.invalid",
    ),
    true,
  );
  assert.equal(
    openclaw.warnings.some((warning) =>
      warning.code === "replay.openclaw.jsonl.invalid_line",
    ),
    true,
  );
});

test("replay normalizers throw on malformed message rows in strict mode", () => {
  assert.throws(
    () => chatgptReplayNormalizer.parse({ messages: [null] }, { strict: true }),
    /malformed ChatGPT replay message/i,
  );
  assert.throws(
    () => claudeReplayNormalizer.parse({ messages: [null] }, { strict: true }),
    /malformed Claude message/i,
  );
  assert.throws(
    () => openclawReplayNormalizer.parse([null], { strict: true }),
    /non-object replay turn/i,
  );
  assert.throws(
    () => openclawReplayNormalizer.parse({ records: [null] }, { strict: true }),
    /non-object OpenClaw replay record/i,
  );
});
