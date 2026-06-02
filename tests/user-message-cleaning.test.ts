import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanUserMessage,
  configureOpenClawChannelEnvelopePrefixes,
} from "../src/user-message-cleaning.ts";

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

test("cleanUserMessage uses configured OpenClaw channel envelope prefixes", () => {
  try {
    configureOpenClawChannelEnvelopePrefixes(["Discord", "Google Chat"]);
    assert.equal(
      cleanUserMessage("[Discord user id:123 2026-06-02] Remember this [message_id: host-2]"),
      "Remember this",
    );
    assert.equal(
      cleanUserMessage("[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]"),
      "[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]",
    );
  } finally {
    configureOpenClawChannelEnvelopePrefixes(["OpenClaw"]);
  }
});

test("configureOpenClawChannelEnvelopePrefixes resets to legacy OpenClaw default", () => {
  try {
    configureOpenClawChannelEnvelopePrefixes(["Discord"]);
    assert.equal(
      cleanUserMessage("[Discord user id:123 2026-06-02] Remember this [message_id: host-2]"),
      "Remember this",
    );

    configureOpenClawChannelEnvelopePrefixes([]);
    assert.equal(
      cleanUserMessage("[Discord user id:123 2026-06-02] Keep literal [message_id: host-2]"),
      "[Discord user id:123 2026-06-02] Keep literal [message_id: host-2]",
    );
    assert.equal(
      cleanUserMessage("[OpenClaw user id:123 2026-06-02] Remember this [message_id: host-3]"),
      "Remember this",
    );
  } finally {
    configureOpenClawChannelEnvelopePrefixes(["OpenClaw"]);
  }
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
