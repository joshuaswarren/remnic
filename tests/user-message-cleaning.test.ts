import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanUserMessage,
  createOpenClawUserMessageCleaner,
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

test("cleanUserMessage preserves broad legacy channel envelope cleanup by default", () => {
  assert.equal(
    cleanUserMessage("[Discord user id:123 2026-06-02] Remember the legacy default [message_id: host-2]"),
    "Remember the legacy default",
  );
});

test("cleanUserMessage uses configured OpenClaw channel envelope prefixes", () => {
  const channelEnvelopePrefixes = ["Discord", "Google Chat"];
  assert.equal(
    cleanUserMessage(
      "[Discord user id:123 2026-06-02] Remember this [message_id: host-2]",
      {
        channelEnvelopePrefixes,
        includeLegacyChannelEnvelopePattern: false,
      },
    ),
    "Remember this",
  );
  assert.equal(
    cleanUserMessage(
      "[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]",
      {
        channelEnvelopePrefixes,
        includeLegacyChannelEnvelopePattern: false,
      },
    ),
    "[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]",
  );
});

test("empty channel envelope prefixes reset to legacy OpenClaw default", () => {
  const discordPrefixes = ["Discord"];
  assert.equal(
    cleanUserMessage(
      "[Discord user id:123 2026-06-02] Remember this [message_id: host-2]",
      { channelEnvelopePrefixes: discordPrefixes },
    ),
    "Remember this",
  );

  const defaultPrefixes: string[] = [];
  assert.equal(
    cleanUserMessage(
      "[Discord user id:123 2026-06-02] Keep literal [message_id: host-2]",
      {
        channelEnvelopePrefixes: defaultPrefixes,
        includeLegacyChannelEnvelopePattern: false,
      },
    ),
    "[Discord user id:123 2026-06-02] Keep literal [message_id: host-2]",
  );
  assert.equal(
    cleanUserMessage(
      "[OpenClaw user id:123 2026-06-02] Remember this [message_id: host-3]",
      {
        channelEnvelopePrefixes: defaultPrefixes,
        includeLegacyChannelEnvelopePattern: false,
      },
    ),
    "Remember this",
  );
});

test("createOpenClawUserMessageCleaner isolates channel prefixes per instance", () => {
  const discordCleaner = createOpenClawUserMessageCleaner(
    ["Discord"],
    { includeLegacyChannelEnvelopePattern: false },
  );
  const slackCleaner = createOpenClawUserMessageCleaner(
    ["Slack"],
    { includeLegacyChannelEnvelopePattern: false },
  );

  assert.equal(
    discordCleaner("[Discord user id:123 2026-06-02] Remember this [message_id: host-2]"),
    "Remember this",
  );
  assert.equal(
    discordCleaner("[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]"),
    "[Slack user id:123 2026-06-02] Keep literal [message_id: host-3]",
  );
  assert.equal(
    slackCleaner("[Slack user id:123 2026-06-02] Remember this [message_id: host-3]"),
    "Remember this",
  );
});

test("createOpenClawUserMessageCleaner defaults to legacy broad envelope cleaning", () => {
  const cleaner = createOpenClawUserMessageCleaner(["Discord"]);

  assert.equal(
    cleaner("[Slack user id:123 2026-06-02] Remember this [message_id: host-3]"),
    "Remember this",
  );
});

test("createOpenClawUserMessageCleaner can preserve legacy broad envelope cleaning", () => {
  const legacyCleaner = createOpenClawUserMessageCleaner(
    ["OpenClaw"],
    { includeLegacyChannelEnvelopePattern: true },
  );
  assert.equal(
    legacyCleaner("[Discord user id:123 2026-06-02] Remember this [message_id: host-2]"),
    "Remember this",
  );
});

test("channel envelope cleaning remains case-sensitive", () => {
  assert.equal(
    cleanUserMessage("[discord user ID:123 2026-06-02] Keep literal [message_id: host-2]"),
    "[discord user ID:123 2026-06-02] Keep literal [message_id: host-2]",
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
