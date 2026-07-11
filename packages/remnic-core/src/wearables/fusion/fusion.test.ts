import assert from "node:assert/strict";
import { test } from "node:test";

import { emptySpeakerRegistry } from "../speakers.js";
import type { WearableConversation } from "../types.js";
import {
  clusterConversations,
  fuseDay,
  fusionInputsFromConversations,
  reconstructFusionInputs,
  serializeFusionDay,
  parseFusionDay,
} from "./index.js";
import type { FusionConversationInput } from "./index.js";

const DATE = "2026-06-10";
const REGISTRY = emptySpeakerRegistry();

/** Build a minimal wearable conversation with resolved self/others. */
function conversation(
  source: string,
  id: string,
  startIso: string,
  segments: Array<{
    text: string;
    speakerKey?: string;
    isWearer?: boolean;
    startIso?: string;
    endIso?: string;
  }>,
  extra: Partial<WearableConversation> = {},
): WearableConversation {
  return {
    id,
    source,
    startIso,
    segments: segments.map((segment) => ({
      text: segment.text,
      speakerKey: segment.speakerKey ?? "user",
      ...(segment.isWearer !== undefined ? { isWearer: segment.isWearer } : {}),
      ...(segment.startIso !== undefined ? { startIso: segment.startIso } : {}),
      ...(segment.endIso !== undefined ? { endIso: segment.endIso } : {}),
    })),
    ...extra,
  };
}

function inputs(
  ...perSource: Array<{ source: string; conversations: WearableConversation[] }>
): FusionConversationInput[] {
  return perSource.flatMap(({ source, conversations }) =>
    fusionInputsFromConversations(source, conversations, REGISTRY),
  );
}

test("exact overlap: two sources, same time/text fuse to one segment, no disagreement", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation(
            "limitless",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [
              {
                text: "Let's ship the launch on Friday.",
                isWearer: true,
                startIso: "2026-06-10T09:00:30.000Z",
              },
            ],
            { endIso: "2026-06-10T09:01:00.000Z" },
          ),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation(
            "bee",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [
              {
                text: "Let's ship the launch on Friday.",
                isWearer: true,
                startIso: "2026-06-10T09:00:31.000Z",
              },
            ],
            { endIso: "2026-06-10T09:01:00.000Z" },
          ),
        ],
      },
    ),
    { sourceTrust: { limitless: 0.9, bee: 0.7 } },
  );

  assert.equal(fused.conversations.length, 1);
  const conv = fused.conversations[0]!;
  assert.deepEqual(conv.sources.sort(), ["bee", "limitless"]);
  assert.equal(conv.segments.length, 1, "overlapping identical text collapses to one segment");
  const segment = conv.segments[0]!;
  assert.equal(segment.text, "Let's ship the launch on Friday.");
  assert.equal(segment.provenance.source, "limitless");
  assert.equal(segment.provenance.reason, "higher-trust");
  assert.equal(segment.provenance.alternatives.length, 1);
  assert.equal(conv.disagreements.length, 0, "identical text is not a disagreement");
});

test("partial overlap: adjacent conversations still cluster into one fused conversation", () => {
  const clusters = clusterConversations(
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation(
            "limitless",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [{ text: "First topic.", isWearer: true }],
            { endIso: "2026-06-10T09:20:00.000Z" },
          ),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation(
            "bee",
            "c1",
            "2026-06-10T09:22:00.000Z",
            [{ text: "Second topic.", isWearer: true }],
            { endIso: "2026-06-10T09:40:00.000Z" },
          ),
        ],
      },
    ),
  );
  // 2-minute gap < 5-minute default proximity -> one cluster.
  assert.equal(clusters.length, 1);
});

test("conflicting ASR text for the same window is recorded as a disagreement", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Let's ship the launch on Friday.",
              isWearer: true,
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Let's skip the launch entirely.",
              isWearer: true,
              startIso: "2026-06-10T09:00:31.000Z",
            },
          ]),
        ],
      },
    ),
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.disagreements.length, 1);
  const disagreement = conv.disagreements[0]!;
  assert.equal(disagreement.kind, "asr-text");
  assert.equal(disagreement.candidates.length, 2);
  assert.ok(disagreement.provisional, "a provisional winner is kept, never silently dropped");
  // The fused segment carries lowered confidence when a conflict exists.
  assert.ok(conv.segments[0]!.confidence < 0.8);
});

test("truncation is more-complete, not a disagreement: verbatim beats clipped", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "The deploy window opens at three and closes at five.",
              isWearer: true,
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "The deploy window opens at three and closes at",
              isWearer: true,
              startIso: "2026-06-10T09:00:31.000Z",
            },
          ]),
        ],
      },
    ),
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.disagreements.length, 0, "a clipped transcript is not a conflict");
  const segment = conv.segments[0]!;
  assert.equal(
    segment.text,
    "The deploy window opens at three and closes at five.",
  );
  assert.equal(segment.provenance.reason, "more-complete");
});

test("summary-style + verbatim-style source: summary preserved, verbatim segments win", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "omi",
        conversations: [
          conversation(
            "omi",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [{ text: "Discussed the launch.", isWearer: true }],
            {
              endIso: "2026-06-10T09:10:00.000Z",
              title: "Launch sync",
              summary: "A short summary of the launch discussion.",
            },
          ),
        ],
      },
      {
        source: "limitless",
        conversations: [
          conversation(
            "limitless",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [
              {
                text: "We agreed to launch on Friday at noon.",
                isWearer: true,
                startIso: "2026-06-10T09:00:30.000Z",
              },
              {
                text: "I will send the checklist.",
                isWearer: true,
                startIso: "2026-06-10T09:01:00.000Z",
              },
            ],
            { endIso: "2026-06-10T09:10:00.000Z" },
          ),
        ],
      },
    ),
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.title, "Launch sync");
  assert.equal(conv.summary, "A short summary of the launch discussion.");
  // Verbatim source contributes more complete, on-the-record segments.
  assert.ok(
    conv.segments.some((segment) =>
      segment.text.startsWith("We agreed to launch"),
    ),
    "verbatim segment is retained",
  );
});

test("missing timestamps: segments without start are preserved and still fused", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "No timestamp on this utterance.", isWearer: true },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "No timestamp on this utterance.", isWearer: true },
          ]),
        ],
      },
    ),
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 1);
  assert.equal(conv.segments[0]!.text, "No timestamp on this utterance.");
  assert.equal(conv.segments[0]!.startIso, undefined);
});

test("speaker-label uncertainty: generic single-source label carries lowered confidence", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Hello there.",
              speakerKey: "0",
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
    ),
  );

  const conv = fused.conversations[0]!;
  const generic = conv.speakers.find((speaker) => !speaker.isSelf);
  assert.ok(generic, "a non-self speaker is present");
  assert.ok(
    generic!.confidence <= 0.5,
    "a generic label seen in one source is marked uncertain",
  );
});

test("idempotency: identical inputs produce a stable id and content hash", () => {
  const a = fuseDay(
    DATE,
    inputs({
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Stable input.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    }),
  );
  // Re-run with a different source ORDER — must hash identically.
  const b = fuseDay(
    DATE,
    inputs({
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Stable input.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    }),
  );

  assert.equal(a.conversations[0]!.id, b.conversations[0]!.id);
  assert.equal(a.contentHash, b.contentHash);
});

test("serialize/parse round-trips a fused day file", () => {
  const fused = fuseDay(
    DATE,
    inputs({
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Round trip.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    }),
  );
  const serialized = serializeFusionDay(
    {
      kind: "wearable-fusion",
      date: DATE,
      sourceCount: fused.sources.length,
      conversationCount: fused.conversations.length,
      contentHash: fused.contentHash,
      fusedAt: "2026-06-11T00:00:00.000Z",
    },
    fused.conversations,
  );
  const parsed = parseFusionDay(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.meta.kind, "wearable-fusion");
  assert.equal(parsed!.meta.date, DATE);
  assert.equal(parsed!.conversations.length, 1);
  assert.equal(parsed!.conversations[0]!.segments[0]!.text, "Round trip.");
});

test("parseFusionDay returns null for non-fusion content", () => {
  assert.equal(parseFusionDay("---\nkind: wearable-transcript\n---\n\nbody\n"), null);
  assert.equal(parseFusionDay("not a transcript at all"), null);
});

test("reconstructFusionInputs parses a rendered transcript body", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 09:00–09:20 · Morning coffee (conversation conv-1)",
    "",
    "**Me (you)** [09:00]: Hello world.",
    "**Jane** [09:01]: Hi there.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.conversationId, "conv-1");
  assert.equal(conv.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(conv.segments.length, 2);
  assert.equal(conv.segments[0]!.speaker, "Me (you)");
  assert.equal(conv.segments[0]!.isSelf, true);
  assert.equal(conv.segments[1]!.speaker, "Jane");
  assert.equal(conv.segments[1]!.isSelf, false);
});
