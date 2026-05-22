import assert from "node:assert/strict";
import test from "node:test";

import { cleanUserMessage } from "../src/user-message-cleaning.ts";

test("cleanUserMessage preserves user-authored trailing message IDs", () => {
  assert.equal(
    cleanUserMessage("Please document this literal marker: [message_id: user-kept]"),
    "Please document this literal marker: [message_id: user-kept]",
  );
});

test("cleanUserMessage removes message IDs only with a platform header", () => {
  assert.equal(
    cleanUserMessage("[OpenClaw user id:123 2026-05-22] Remember the deployment [message_id: host-1]"),
    "Remember the deployment",
  );
});

test("cleanUserMessage only strips markdown memory context as a leading preamble", () => {
  assert.equal(
    cleanUserMessage("User text\n\n## Memory Context (Remnic)\nKeep this literal section."),
    "User text\n\n## Memory Context (Remnic)\nKeep this literal section.",
  );

  assert.equal(
    cleanUserMessage("## Memory Context (Remnic)\nInjected recall\n## Request\nDo the work"),
    "## Request\nDo the work",
  );
});
