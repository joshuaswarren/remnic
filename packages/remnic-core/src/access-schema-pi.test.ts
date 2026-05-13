import assert from "node:assert/strict";
import test from "node:test";

import { validateRequest } from "./access-schema.js";

test("observe schema accepts Pi source format", () => {
  const result = validateRequest("observe", {
    sessionKey: "pi:session",
    messages: [
      {
        role: "user",
        content: "Use the existing repo conventions.",
        sourceFormat: "pi",
      },
    ],
  });

  assert.equal(result.success, true);
});

test("observe schema rejects unknown source format", () => {
  const result = validateRequest("observe", {
    sessionKey: "pi:session",
    messages: [
      {
        role: "user",
        content: "Use the existing repo conventions.",
        sourceFormat: "unknown-agent",
      },
    ],
  });

  assert.equal(result.success, false);
});

test("LCM compaction schemas validate Pi extension requests", () => {
  const flush = validateRequest("lcmCompactionFlush", {
    sessionKey: "pi:session",
    namespace: "work",
  });
  assert.equal(flush.success, true);

  const record = validateRequest("lcmCompactionRecord", {
    sessionKey: "pi:session",
    namespace: "work",
    tokensBefore: 4000,
    tokensAfter: 900,
  });
  assert.equal(record.success, true);
});

test("LCM compaction record rejects invalid token counts", () => {
  const result = validateRequest("lcmCompactionRecord", {
    sessionKey: "pi:session",
    tokensBefore: -1,
    tokensAfter: 900,
  });

  assert.equal(result.success, false);
});
