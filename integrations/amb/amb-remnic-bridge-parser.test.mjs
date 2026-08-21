import assert from "node:assert/strict";
import test from "node:test";

import { parseAmbDocumentMessages } from "../../packages/bench/scripts/amb-remnic-bridge.mjs";

test("AMB bridge parser splits single-newline user and assistant turns", () => {
  const messages = parseAmbDocumentMessages({
    id: "doc-single-newline",
    content: "User: first\nAssistant: second",
  });

  assert.deepEqual(messages, [
    { role: "system", content: "AMB document id=doc-single-newline" },
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]);
});

test("AMB bridge parser still supports blank-line-separated timestamped turns", () => {
  const messages = parseAmbDocumentMessages({
    id: "doc-blank-line",
    content: "[2026-04-26 10:00] User: first\n\n[2026-04-26 10:01] Assistant: second",
  });

  assert.deepEqual(messages, [
    { role: "system", content: "AMB document id=doc-blank-line" },
    { role: "user", content: "[2026-04-26 10:00] first" },
    { role: "assistant", content: "[2026-04-26 10:01] second" },
  ]);
});
