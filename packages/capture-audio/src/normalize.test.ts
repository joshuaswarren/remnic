import assert from "node:assert/strict";
import { test } from "node:test";

import { daemonConversationToWearable, DESKTOP_SOURCE_ID } from "./normalize.js";
import type { DaemonConversation } from "./spool.js";

const FINAL: DaemonConversation = {
  id: "conv_01HXYZ",
  startedAtUtc: "2026-06-10T14:00:00.000Z",
  endedAtUtc: "2026-06-10T14:12:00.000Z",
  state: "final",
  segmentCount: 2,
  segments: [
    {
      textRaw: "Where did we land on the desktop connector?",
      speakerKey: "cluster-2",
      isWearer: false,
      channel: "system",
      startUtc: "2026-06-10T14:00:01.000Z",
      endUtc: "2026-06-10T14:00:05.000Z",
    },
    {
      textRaw: "Shipping it from capture-audio.",
      speakerKey: null,
      isWearer: true,
      channel: "mic",
      startUtc: "2026-06-10T14:00:06.000Z",
      endUtc: "2026-06-10T14:00:09.000Z",
    },
  ],
};

test("maps a final daemon conversation to the exact WearableConversation fields", () => {
  const conversation = daemonConversationToWearable(FINAL);
  assert.deepEqual(conversation, {
    id: "conv_01HXYZ",
    source: DESKTOP_SOURCE_ID,
    startIso: "2026-06-10T14:00:00.000Z",
    endIso: "2026-06-10T14:12:00.000Z",
    segments: [
      {
        text: "Where did we land on the desktop connector?",
        speakerKey: "cluster-2",
        startIso: "2026-06-10T14:00:01.000Z",
        endIso: "2026-06-10T14:00:05.000Z",
      },
      {
        text: "Shipping it from capture-audio.",
        speakerKey: "unknown",
        isWearer: true,
        startIso: "2026-06-10T14:00:06.000Z",
        endIso: "2026-06-10T14:00:09.000Z",
      },
    ],
  });
});

test("source id is the wearable connector id 'desktop'", () => {
  assert.equal(DESKTOP_SOURCE_ID, "desktop");
  assert.equal(daemonConversationToWearable(FINAL).source, "desktop");
});

test("an open-ended conversation (null endedAtUtc) omits endIso", () => {
  const conversation = daemonConversationToWearable({
    ...FINAL,
    endedAtUtc: null,
    segments: [],
  });
  assert.equal(conversation.endIso, undefined);
  assert.equal(conversation.segments.length, 0);
});
