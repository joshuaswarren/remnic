import assert from "node:assert/strict";
import { test } from "node:test";

import { composeDayTranscriptBody } from "../day-store.js";
import { emptySpeakerRegistry } from "../speakers.js";
import type { WearableConversation } from "../types.js";
import {
  DEFAULT_PROXIMITY_GAP_MS,
  DEFAULT_WINDOW_TOLERANCE_MS,
  FUSION_ALGO_VERSION,
  canonicalDayKey,
  clusterConversations,
  composeFusionDayMeta,
  fuseDay,
  fusionInputsFromConversations,
  hashFusionBody,
  reconstructFusionInputs,
  serializeFusionDay,
  parseFusionDay,
} from "./index.js";
import type { FusionConversationInput } from "./index.js";

const DATE = "2026-06-10";
const REGISTRY = emptySpeakerRegistry();

function conversation(
  source: string,
  id: string,
  startIso: string,
  segments: Array<{
    text: string;
    speakerKey?: string;
    speakerName?: string;
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
      ...(segment.speakerName !== undefined ? { speakerName: segment.speakerName } : {}),
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
  assert.equal(clusters.length, 1);
});

test("explicit end earlier than start is clamped to start so a within-gap neighbor still clusters (#1849)", () => {
  const clusters = clusterConversations(
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation(
            "limitless",
            "c1",
            "2026-06-10T09:00:00.000Z",
            [{ text: "Clamped window topic.", isWearer: true }],
            { endIso: "2026-06-10T08:55:00.000Z" },
          ),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation(
            "bee",
            "c1",
            "2026-06-10T09:03:00.000Z",
            [{ text: "Neighbor topic.", isWearer: true }],
            { endIso: "2026-06-10T09:10:00.000Z" },
          ),
        ],
      },
    ),
  );
  assert.equal(
    clusters.length,
    1,
    "clamped-to-start end keeps the within-gap neighbor in one cluster",
  );
  assert.deepEqual(
    clusters[0]!.map((c) => c.source).sort(),
    ["bee", "limitless"],
  );
});

test("same-source conversations within the proximity gap stay separate without a cross-source bridge (issue #1849)", () => {
  const a: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    endIso: "2026-06-10T09:10:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "First meeting." }],
  };
  const b: FusionConversationInput = {
    source: "limitless",
    conversationId: "c2",
    startIso: "2026-06-10T09:12:00.000Z",
    endIso: "2026-06-10T09:20:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Second meeting." }],
  };
  const clusters = clusterConversations([a, b]);
  assert.equal(
    clusters.length,
    2,
    "same-source conversations stay separate without a cross-source bridge",
  );
  assert.deepEqual(
    clusters.map((c) => c[0]!.conversationId),
    ["c1", "c2"],
    "each conversation is its own cluster, in chronological order",
  );
});

test("different-source conversations within the proximity gap still merge (cross-source bridge)", () => {
  const a: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    endIso: "2026-06-10T09:10:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "First meeting." }],
  };
  const b: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:12:00.000Z",
    endIso: "2026-06-10T09:20:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "First meeting." }],
  };
  const clusters = clusterConversations([a, b]);
  assert.equal(clusters.length, 1, "different-source conversations within the gap merge");
  assert.deepEqual(clusters[0]!.map((c) => c.source).sort(), ["bee", "limitless"]);
});

test("same-source conversations bridged by a different-source chain merge into one cluster (issue #1849)", () => {
  const a: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    endIso: "2026-06-10T09:03:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Topic one." }],
  };
  const b: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:06:00.000Z",
    endIso: "2026-06-10T09:10:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Topic one." }],
  };
  const c: FusionConversationInput = {
    source: "limitless",
    conversationId: "c2",
    startIso: "2026-06-10T09:09:00.000Z",
    endIso: "2026-06-10T09:20:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Topic two." }],
  };
  const clusters = clusterConversations([a, b, c]);
  assert.equal(
    clusters.length,
    1,
    "the bee conversation bridges the two limitless conversations into one cluster",
  );
  assert.deepEqual(
    clusters[0]!.map((conv) => conv.conversationId),
    ["c1", "c1", "c2"],
    "cluster is sorted by (start, source, id): limitless c1, bee c1, limitless c2",
  );
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

test("content hash folds fusion config: same inputs, changed knob => new hash", () => {
  const day = inputs(
    {
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Config-sensitive hash.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    },
    {
      source: "bee",
      conversations: [
        conversation("bee", "c2", "2026-06-10T09:00:20.000Z", [
          { text: "Second source.", isWearer: false, startIso: "2026-06-10T09:00:40.000Z" },
        ]),
      ],
    },
  );

  const base = fuseDay(DATE, day);

  const widerGap = fuseDay(DATE, day, { proximityGapMs: 600_000 });
  assert.notEqual(
    base.contentHash,
    widerGap.contentHash,
    "proximityGapMs change must invalidate the content hash",
  );
  const tighterTol = fuseDay(DATE, day, { windowToleranceMs: 5_000 });
  assert.notEqual(
    base.contentHash,
    tighterTol.contentHash,
    "windowToleranceMs change must invalidate the content hash",
  );
  const reweighted = fuseDay(DATE, day, { sourceTrust: { limitless: 0.95 } });
  assert.notEqual(
    base.contentHash,
    reweighted.contentHash,
    "per-source trust change must invalidate the content hash",
  );

  const withDefaults = fuseDay(DATE, day, {
    proximityGapMs: DEFAULT_PROXIMITY_GAP_MS,
    windowToleranceMs: DEFAULT_WINDOW_TOLERANCE_MS,
  });
  assert.equal(
    base.contentHash,
    withDefaults.contentHash,
    "explicit defaults must hash identically to omission",
  );
  assert.equal(
    base.conversations[0]!.id,
    widerGap.conversations[0]!.id,
    "conversation id is input-only and stable across a config change",
  );
});

test("content hash folds the fusion algorithm version (issue #1849)", () => {
  const day = inputs(
    {
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Algorithm-sensitive hash.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    },
    {
      source: "bee",
      conversations: [
        conversation("bee", "c2", "2026-06-10T09:00:20.000Z", [
          { text: "Second source.", isWearer: false, startIso: "2026-06-10T09:00:40.000Z" },
        ]),
      ],
    },
  );

  const current = fuseDay(DATE, day);

  const staleHash = canonicalDayKey(DATE, day, {}, "2000-01-01-stale");
  assert.notEqual(
    current.contentHash,
    staleHash,
    "a different algorithm version must invalidate the content hash",
  );

  assert.equal(
    current.contentHash,
    canonicalDayKey(DATE, day, {}, FUSION_ALGO_VERSION),
    "same version must produce the same hash",
  );

  assert.ok(
    current.conversations[0]!.id.startsWith("fusion-"),
    "conversation id is unaffected by the algorithm version",
  );
});

test("hash encoding is delimiter-injection-safe: distinct inputs differing only by where a `|`/newline falls never collide (issue #1849)", () => {
  const startIso = "2026-06-10T09:00:00.000Z";

  const split: FusionConversationInput[] = [
    {
      source: "limitless",
      conversationId: "c1",
      startIso,
      segments: [
        { speaker: "Alice", isSelf: false, text: "Bob\nseg|Carol|other|||Dave" },
      ],
    },
  ];
  const two: FusionConversationInput[] = [
    {
      source: "limitless",
      conversationId: "c1",
      startIso,
      segments: [
        { speaker: "Alice", isSelf: false, text: "Bob" },
        { speaker: "Carol", isSelf: false, text: "Dave" },
      ],
    },
  ];

  const fusedSplit = fuseDay(DATE, split);
  const fusedTwo = fuseDay(DATE, two);

  assert.notEqual(
    fusedSplit.contentHash,
    fusedTwo.contentHash,
    "a segment text containing a forged delimiter must not collide with two real segments",
  );
  assert.notEqual(
    fusedSplit.conversations[0]!.id,
    fusedTwo.conversations[0]!.id,
    "the per-conversation id must also be collision-safe",
  );

  const labelPipe: FusionConversationInput[] = [
    {
      source: "limitless",
      conversationId: "c1",
      startIso,
      segments: [{ speaker: "Alice|Bob", isSelf: false, text: "Carol" }],
    },
  ];
  const textPipe: FusionConversationInput[] = [
    {
      source: "limitless",
      conversationId: "c1",
      startIso,
      segments: [{ speaker: "Alice", isSelf: false, text: "Bob|Carol" }],
    },
  ];
  assert.notEqual(
    fuseDay(DATE, labelPipe).contentHash,
    fuseDay(DATE, textPipe).contentHash,
    "a `|` in a speaker label vs in the text must hash differently",
  );

  assert.equal(
    fuseDay(DATE, split).contentHash,
    fuseDay(DATE, JSON.parse(JSON.stringify(split))).contentHash,
    "identical logical inputs must hash identically (idempotent skip still works)",
  );
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
  const meta = composeFusionDayMeta(
    DATE,
    fused.conversations,
    fused.sources,
    fused.contentHash,
    "2026-06-11T00:00:00.000Z",
  );
  const serialized = serializeFusionDay(meta, fused.conversations);
  const parsed = parseFusionDay(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.meta.kind, "wearable-fusion");
  assert.equal(parsed!.meta.date, DATE);
  assert.equal(parsed!.meta.bodyHash, hashFusionBody(fused.conversations));
  assert.equal(parsed!.parseOk, true);
  assert.equal(parsed!.conversations.length, 1);
  assert.equal(parsed!.conversations[0]!.segments[0]!.text, "Round trip.");
});

test("parseFusionDay returns null for non-fusion content", () => {
  assert.equal(parseFusionDay("---\nkind: wearable-transcript\n---\n\nbody\n"), null);
  assert.equal(parseFusionDay("not a transcript at all"), null);
});

test("parseFusionDay accepts a well-formed conversation array", () => {
  const fused = fuseDay(
    DATE,
    inputs({
      source: "limitless",
      conversations: [
        conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
          { text: "Well formed.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        ]),
      ],
    }),
  );
  const serialized = serializeFusionDay(
    composeFusionDayMeta(DATE, fused.conversations, fused.sources, fused.contentHash, "2026-06-11T00:00:00.000Z"),
    fused.conversations,
  );
  const parsed = parseFusionDay(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.parseOk, true);
  assert.equal(parsed!.conversations.length, fused.conversations.length);
});

test("parseFusionDay accepts a legitimately-empty body", () => {
  const serialized = serializeFusionDay(
    composeFusionDayMeta(DATE, [], [], "abc", "2026-06-11T00:00:00.000Z"),
    [],
  );
  const parsed = parseFusionDay(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.parseOk, true);
  assert.equal(parsed!.conversations.length, 0);
});

test("parseFusionDay rejects corrupt bodies even with matching hash + count", () => {
  const header = [
    "---",
    "kind: wearable-fusion",
    `date: ${JSON.stringify(DATE)}`,
    "sourceCount: 1",
    "conversationCount: 1",
    'contentHash: "matches"',
    'bodyHash: "matches"',
    'fusedAt: "2026-06-11T00:00:00.000Z"',
    "---",
    "",
  ].join("\n");
  for (const [body, expectOk] of [
    ['{"not":"array"}', false],
    ["[{}]", false],
    ["[null]", false],
    ['[{"id":1}]', false],
    ['[{"id":"x"}]', false],
    ["[]", true],
  ] as const) {
    const parsed = parseFusionDay(`${header}${body}\n`);
    assert.ok(parsed, `expected a non-null parse for body ${body}`);
    assert.equal(
      parsed!.parseOk,
      expectOk,
      `expected parseOk:${expectOk} for body ${body}`,
    );
    if (!expectOk) {
      assert.equal(parsed!.conversations.length, 0, `expected empty convs for body ${body}`);
    }
  }
});

test("parseFusionDay rejects a blank or whitespace-only body as corrupt (#1849)", () => {
  const header = [
    "---",
    "kind: wearable-fusion",
    `date: ${JSON.stringify(DATE)}`,
    "sourceCount: 0",
    "conversationCount: 0",
    'contentHash: "abc"',
    'bodyHash: "def"',
    'fusedAt: "2026-06-11T00:00:00.000Z"',
    "---",
    "",
  ].join("\n");
  for (const body of ["", "   ", "\n\n", "\t"]) {
    const parsed = parseFusionDay(`${header}${body}\n`);
    assert.ok(parsed, `expected non-null parse for blank body`);
    assert.equal(
      parsed!.parseOk,
      false,
      `blank/whitespace body must be corrupt: ${JSON.stringify(body)}`,
    );
    assert.equal(parsed!.conversations.length, 0);
  }
  const validParsed = parseFusionDay(`${header}[]\n`);
  assert.ok(validParsed);
  assert.equal(validParsed!.parseOk, true);
  assert.equal(validParsed!.conversations.length, 0);
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

test("reconstruct normalizes renderer 24:xx midnight clocks to valid 00:xx ISO", () => {
  // en-US hour12:false renders the first wall-clock hour as 24:xx on some
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 24:00–24:30 · Late night (conversation c1)",
    "",
    "**Me (you)** [24:05]: Hello world.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T00:00:00.000Z");
  assert.equal(conv.endIso, "2026-06-10T00:30:00.000Z");
  assert.ok(Number.isFinite(Date.parse(conv.startIso!)), "startIso is a valid timestamp");
  assert.equal(conv.segments.length, 1);
  const segIso = conv.segments[0]!.startIso!;
  assert.equal(segIso, "2026-06-10T00:05:00.000Z");
  assert.ok(Number.isFinite(Date.parse(segIso)), "24:05 -> valid 00:05 ISO");
});

test("reconstruct rolls a cross-midnight conversation end into the next day", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 23:55–00:10 · Late call (conversation c1)",
    "",
    "**Me (you)** [23:58]: Still talking.",
    "**Jane** [00:05]: After midnight.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T23:55:00.000Z");
  assert.equal(conv.endIso, "2026-06-11T00:10:00.000Z");
  assert.ok(conv.endIso! >= conv.startIso!, "endIso must not precede startIso");
  const isos = conv.segments.map((s) => s.startIso);
  assert.ok(
    isos.includes("2026-06-10T23:58:00.000Z"),
    "pre-midnight segment stays on the rendered date",
  );
  assert.ok(
    isos.includes("2026-06-11T00:05:00.000Z"),
    "post-midnight segment rolls to the next day",
  );
});

test("reconstruct rolls a post-midnight segment even when the heading end clock is missing", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 23:55–--:-- · Late call (conversation c1)",
    "",
    "**Me (you)** [23:58]: Still talking.",
    "**Jane** [00:05]: After midnight.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T23:55:00.000Z");
  assert.equal(conv.endIso, undefined);
  const isos = conv.segments.map((s) => s.startIso);
  assert.ok(
    isos.includes("2026-06-10T23:58:00.000Z"),
    "pre-midnight segment stays on the rendered date",
  );
  assert.ok(
    isos.includes("2026-06-11T00:05:00.000Z"),
    "post-midnight segment rolls to the next day despite a missing heading end",
  );
  const rolled = conv.segments.find((s) => s.startIso === "2026-06-11T00:05:00.000Z");
  assert.ok(rolled, "rolled segment present");
  assert.ok(
    Date.parse(rolled!.startIso!) > Date.parse(conv.startIso!),
    "segment ISO must sort after the start ISO",
  );
});

test("truncated high-trust text yields to a longer corroborating transcript", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "The deploy window opens at",
              isWearer: true,
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
      {
        source: "omi",
        conversations: [
          conversation("omi", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "The deploy window opens at three and closes at five.",
              isWearer: true,
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
    ),
    { sourceTrust: { bee: 0.95, omi: 0.6 } },
  );
  const conv = fused.conversations[0]!;
  const segment = conv.segments[0]!;
  assert.equal(
    segment.text,
    "The deploy window opens at three and closes at five.",
  );
  assert.equal(segment.provenance.reason, "more-complete");
  assert.equal(segment.provenance.source, "omi");
  assert.equal(conv.disagreements.length, 0, "a truncation is not a disagreement");
});

test("distinct untimestamped same-speaker utterances do not collapse across sources", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "First distinct untimestamped thought.", isWearer: true },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "Second distinct untimestamped thought.", isWearer: true },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(
    conv.segments.length,
    2,
    "distinct untimestamped utterances stay separate, not collapsed",
  );
  const texts = conv.segments.map((s) => s.text).sort();
  assert.deepEqual(texts, [
    "First distinct untimestamped thought.",
    "Second distinct untimestamped thought.",
  ]);
});

test("repeated short utterance attaches to the closest matching group, not the first (issue #1849)", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:20.000Z" },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c2", "2026-06-10T09:00:00.000Z", [
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:21.000Z" },
          ]),
        ],
      },
    ),
    { sourceTrust: { limitless: 0.9, bee: 0.7 } },
  );

  assert.equal(fused.conversations.length, 1);
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);

  const byStart = [...conv.segments].sort((a, b) =>
    (a.startIso ?? "").localeCompare(b.startIso ?? ""),
  );
  assert.equal(byStart[0]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(
    byStart[0]!.provenance.alternatives.length,
    0,
    "B must not corroborate the 09:00:00 utterance under closest-match",
  );
  assert.equal(byStart[1]!.startIso, "2026-06-10T09:00:20.000Z");
  assert.ok(
    byStart[1]!.provenance.alternatives.some((a) => a.source === "bee"),
    "B must corroborate the 09:00:20 utterance (closest match)",
  );
});

test("equal-distance candidate groups tie-break to the earlier anchor (issue #1849)", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c2", "2026-06-10T09:00:00.000Z", [
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:15.000Z" },
          ]),
        ],
      },
    ),
    { sourceTrust: { limitless: 0.9, bee: 0.7 } },
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  const byStart = [...conv.segments].sort((a, b) =>
    (a.startIso ?? "").localeCompare(b.startIso ?? ""),
  );
  assert.equal(byStart[0]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.ok(
    byStart[0]!.provenance.alternatives.some((a) => a.source === "bee"),
    "tie-break must attach B to the earlier anchor (09:00:00)",
  );
  assert.equal(byStart[1]!.startIso, "2026-06-10T09:00:30.000Z");
  assert.equal(
    byStart[1]!.provenance.alternatives.length,
    0,
    "B must not corroborate the 09:00:30 utterance",
  );
});

test("distinct timestamped same-window utterances stay separate, not collapsed", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Meeting with Sarah at noon.",
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
              text: "Lunch with the design team.",
              isWearer: true,
              startIso: "2026-06-10T09:00:31.000Z",
            },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(
    conv.segments.length,
    2,
    "distinct same-window utterances stay separate, not collapsed",
  );
  const texts = conv.segments.map((s) => s.text).sort();
  assert.deepEqual(texts, [
    "Lunch with the design team.",
    "Meeting with Sarah at noon.",
  ]);
  assert.deepEqual(
    conv.segments.map((s) => s.provenance.source).sort(),
    ["bee", "limitless"],
  );
  assert.equal(conv.disagreements.length, 1);
  assert.equal(conv.disagreements[0]!.candidates.length, 2);
});

test("cross-segment ASR disagreement detected for differently-labeled self speakers (#1849)", () => {
  const beeRegistry = {
    ...REGISTRY,
    speakers: {
      "bee:user": {
        name: "Alex",
        isSelf: true,
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    },
  };
  const limitless = fusionInputsFromConversations(
    "limitless",
    [
      conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
        {
          text: "Meeting with Sarah at noon.",
          isWearer: true,
          startIso: "2026-06-10T09:00:30.000Z",
        },
      ]),
    ],
    REGISTRY,
  );
  const bee = fusionInputsFromConversations(
    "bee",
    [
      conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
        {
          text: "Lunch with the design team.",
          isWearer: true,
          startIso: "2026-06-10T09:00:31.000Z",
        },
      ]),
    ],
    beeRegistry,
  );
  const fused = fuseDay(DATE, [...limitless, ...bee]);
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  assert.ok(conv.segments.every((s) => s.isSelf), "both are the wearer");
  assert.notEqual(
    conv.segments[0]!.speaker,
    conv.segments[1]!.speaker,
    "the wearer is labeled differently across the two sources",
  );
  const disagreement = conv.disagreements.find((d) => d.kind === "asr-text");
  assert.ok(
    disagreement,
    "a same-self different-label ASR disagreement is recorded, not skipped",
  );
  assert.equal(disagreement!.candidates.length, 2);
  assert.ok(
    conv.segments.every((s) => s.confidence < 0.8),
    "both disagreeing segments carry lowered confidence",
  );
});

test("differently-labeled self speakers that agree still merge into one segment (#1849)", () => {
  const beeRegistry = {
    ...REGISTRY,
    speakers: {
      "bee:user": {
        name: "Alex",
        isSelf: true,
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    },
  };
  const text = "Let's ship the launch on Friday.";
  const limitless = fusionInputsFromConversations(
    "limitless",
    [
      conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
        { text, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
      ]),
    ],
    REGISTRY,
  );
  const bee = fusionInputsFromConversations(
    "bee",
    [
      conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
        { text, isWearer: true, startIso: "2026-06-10T09:00:31.000Z" },
      ]),
    ],
    beeRegistry,
  );
  const fused = fuseDay(DATE, [...limitless, ...bee]);
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 1);
  assert.equal(conv.segments[0]!.text, text);
  assert.equal(conv.segments[0]!.isSelf, true);
  const asrDisagreement = conv.disagreements.find((d) => d.kind === "asr-text");
  assert.equal(
    asrDisagreement,
    undefined,
    "agreeing utterances produce no cross-segment ASR disagreement",
  );
  assert.ok(
    conv.segments[0]!.confidence > 0.8,
    "corroborated utterance keeps boosted confidence",
  );
});

test("equal-time same-source utterances keep original transcript order, not label order", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Zoe spoke first.",
              speakerName: "Zoe",
              startIso: "2026-06-10T09:00:00.000Z",
            },
            {
              text: "Amy spoke second.",
              speakerName: "Amy",
              startIso: "2026-06-10T09:00:00.000Z",
            },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  assert.deepEqual(
    conv.segments.map((s) => s.text),
    ["Zoe spoke first.", "Amy spoke second."],
    "equal-time utterances keep original transcript order, not label order",
  );
  assert.deepEqual(conv.segments.map((s) => s.speaker), ["Zoe", "Amy"]);
});

test("untimestamped same-source utterances keep original transcript order", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "Zoe untimestamped first.", speakerName: "Zoe" },
            { text: "Amy untimestamped second.", speakerName: "Amy" },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  assert.deepEqual(
    conv.segments.map((s) => s.text),
    ["Zoe untimestamped first.", "Amy untimestamped second."],
  );
  assert.deepEqual(conv.segments.map((s) => s.speaker), ["Zoe", "Amy"]);
});

test("raw diarization keys like SPEAKER_00 are treated as generic speakers", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "omi",
        conversations: [
          conversation("omi", "c1", "2026-06-10T09:00:00.000Z", [
            {
              text: "Hello there.",
              speakerKey: "SPEAKER_00",
              startIso: "2026-06-10T09:00:30.000Z",
            },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  const speaker = conv.speakers.find((s) => !s.isSelf);
  assert.ok(speaker, "a non-self speaker is present");
  assert.equal(speaker!.label, "SPEAKER_00");
  assert.ok(
    speaker!.confidence <= 0.5,
    "raw diarization key is generic (<=0.5), not a confident attribution",
  );
});

test("reconstruct round-trips through the real composeDayTranscriptBody renderer", () => {
  const conversations = [
    conversation(
      "limitless",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [
        { text: "Hello world.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        { text: "Good to see you.", startIso: "2026-06-10T09:01:00.000Z" },
      ],
      { title: "Morning sync", endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("limitless", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body, escaped: true }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.conversationId, "c1");
  assert.equal(conv.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(conv.endIso, "2026-06-10T09:10:00.000Z");
  assert.equal(conv.title, "Morning sync");
  assert.equal(conv.segments.length, 2);
  assert.equal(conv.segments[0]!.text, "Hello world.");
  assert.equal(conv.segments[0]!.isSelf, true);
  assert.equal(conv.segments[0]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(conv.segments[1]!.text, "Good to see you.");
  assert.equal(conv.segments[1]!.isSelf, false);
  assert.equal(conv.segments[1]!.startIso, "2026-06-10T09:01:00.000Z");
});

test("equal-key comparator inputs keep stable input order (deterministic across runs)", () => {
  const textSeed = "Limitless seed text.";
  const textBee1 = "Bee conflict one xyz.";
  const textBee2 = "Bee conflict two xyz.";
  const build = () =>
    fuseDay(
      DATE,
      inputs(
        {
          source: "limitless",
          conversations: [
            conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
              {
                text: textSeed,
                speakerName: "Jane",
                startIso: "2026-06-10T09:00:30.000Z",
              },
            ]),
          ],
        },
        {
          source: "bee",
          conversations: [
            conversation("bee", "c1", "2026-06-10T09:00:05.000Z", [
              {
                text: textBee1,
                speakerName: "Jane",
                startIso: "2026-06-10T09:00:30.000Z",
              },
              {
                text: textBee2,
                speakerName: "Jane",
                startIso: "2026-06-10T09:00:30.000Z",
              },
            ]),
          ],
        },
      ),
    );

  const fused = build();
  assert.deepEqual(build(), fused);

  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 3);
  const disagreement = conv.disagreements.find((d) => d.kind === "asr-text");
  assert.ok(disagreement, "a cross-segment asr-text disagreement is recorded");
  const values = disagreement!.candidates.map((c) => c.value);
  assert.equal(values.length, 3);
  assert.ok(
    values.indexOf(textBee1) < values.indexOf(textBee2),
    "equal-key cands keep stable input order",
  );
});

test("same window + same text + different speaker fuses to one segment with a recorded speaker conflict", () => {
  const text = "Let's ship the launch on Friday.";
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
            { text, speakerName: "Jane", startIso: "2026-06-10T09:00:30.000Z" },
          ]),
        ],
      },
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text, speakerName: "John", startIso: "2026-06-10T09:00:30.000Z" },
          ]),
        ],
      },
    ),
    { sourceTrust: { limitless: 0.9 } },
  );
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 1);
  const segment = conv.segments[0]!;
  assert.equal(segment.text, text);
  assert.equal(segment.speaker, "Jane");
  assert.equal(segment.isSelf, false);
  const speakerDisagreement = conv.disagreements.find(
    (d) => d.kind === "speaker",
  );
  assert.ok(speakerDisagreement, "a speaker disagreement is recorded");
  const labeled = speakerDisagreement!.candidates.map(
    (c) => `${c.source}=${c.value}`,
  );
  assert.deepEqual([...labeled].sort(), ["bee=John", "limitless=Jane"]);
  assert.deepEqual(speakerDisagreement!.provisional, {
    source: "limitless",
    value: "Jane",
  });
  assert.ok(segment.confidence < 0.8);
  const labels = conv.speakers.filter((s) => !s.isSelf).map((s) => s.label);
  assert.ok(
    labels.includes("Jane") && labels.includes("John"),
    "both speaker labels are retained",
  );
});

test("cluster interval spans to the latest segment start when the conversation end is missing", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 09:00–--:-- · Morning (conversation c1)",
    "",
    "**Me (you)** [09:00]: First.",
    "**Jane** [09:15]: Second.",
    "**Jane** [09:30]: Third.",
    "",
  ].join("\n");
  const reconstructed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(reconstructed.length, 1);
  assert.equal(reconstructed[0]!.endIso, undefined, "no end clock -> no endIso");
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:33:00.000Z",
    endIso: "2026-06-10T09:40:00.000Z",
    segments: [
      { speaker: "Bee", isSelf: false, text: "Follow up.", startIso: "2026-06-10T09:33:00.000Z" },
    ],
  };
  const clusters = clusterConversations([...reconstructed, bee]);
  assert.equal(
    clusters.length,
    1,
    "missing-end conversation clusters by its last segment start, not its conversation start",
  );
});

test("missing-end interval does not over-extend: a neighbor past the gap of the last segment stays separate", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 09:00–--:-- · Morning (conversation c1)",
    "",
    "**Me (you)** [09:00]: First.",
    "**Jane** [09:30]: Last segment.",
    "",
  ].join("\n");
  const reconstructed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:40:00.000Z",
    endIso: "2026-06-10T09:50:00.000Z",
    segments: [
      { speaker: "Bee", isSelf: false, text: "Later.", startIso: "2026-06-10T09:40:00.000Z" },
    ],
  };
  const clusters = clusterConversations([...reconstructed, bee]);
  assert.equal(clusters.length, 2, "10 min past the last segment is outside the gap");
});

test("cluster interval spans rolled cross-midnight segments when the conversation end is missing", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 23:55–--:-- · Late call (conversation c1)",
    "",
    "**Me (you)** [23:58]: Still talking.",
    "**Jane** [00:05]: After midnight.",
    "",
  ].join("\n");
  const reconstructed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(reconstructed.length, 1);
  assert.equal(reconstructed[0]!.endIso, undefined);
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-11T00:08:00.000Z",
    endIso: "2026-06-11T00:15:00.000Z",
    segments: [
      { speaker: "Bee", isSelf: false, text: "Late.", startIso: "2026-06-11T00:08:00.000Z" },
    ],
  };
  const clusters = clusterConversations([...reconstructed, bee]);
  assert.equal(
    clusters.length,
    1,
    "cross-midnight missing-end conversation clusters by its rolled last segment",
  );
});

test("derived interval uses max(segment ends or segment starts) for mixed-segment inputs", () => {
  const mixed: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    segments: [
      {
        speaker: "Jane",
        isSelf: false,
        text: "First.",
        startIso: "2026-06-10T09:00:00.000Z",
        endIso: "2026-06-10T09:10:00.000Z",
      },
      { speaker: "Jane", isSelf: false, text: "Second.", startIso: "2026-06-10T09:20:00.000Z" },
    ],
  };
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:23:00.000Z",
    endIso: "2026-06-10T09:30:00.000Z",
    segments: [
      { speaker: "Bee", isSelf: false, text: "After.", startIso: "2026-06-10T09:23:00.000Z" },
    ],
  };
  const clusters = clusterConversations([mixed, bee]);
  assert.equal(clusters.length, 1, "max segment extent (start beats earlier end) spans the window");
});

test("derived interval is clamped to end >= start for a missing-end conversation", () => {
  const anomalous: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    segments: [
      { speaker: "Jane", isSelf: false, text: "Early.", startIso: "2026-06-10T08:30:00.000Z" },
    ],
  };
  const clusters = clusterConversations([anomalous]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.length, 1);
});

test("fused conversation end spans a missing-end source's later segments, not the short explicit end (issue #1849)", () => {
  const bBody = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 09:00–--:-- · Sync (conversation c1)",
    "",
    "**Me (you)** [09:00]: Plan A.",
    "**Jane** [09:30]: Later topic.",
    "",
  ].join("\n");
  const bInputs = reconstructFusionInputs(DATE, [{ source: "limitless", body: bBody }]);
  assert.equal(bInputs.length, 1);
  assert.equal(bInputs[0]!.endIso, undefined, "B has no heading end");
  const a: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    endIso: "2026-06-10T09:05:00.000Z",
    segments: [
      { speaker: "Me (you)", isSelf: true, text: "Plan A.", startIso: "2026-06-10T09:00:00.000Z" },
    ],
  };
  const fused = fuseDay(DATE, [...bInputs, a]);
  assert.equal(fused.conversations.length, 1, "A + B cluster into one conversation");
  assert.ok(
    fused.conversations[0]!.segments.some((s) => s.text === "Later topic."),
    "B's later segment is preserved",
  );
  assert.equal(
    fused.conversations[0]!.endIso,
    "2026-06-10T09:30:00.000Z",
    "fused end spans B's last segment start, not A's short explicit end",
  );
});

test("fused conversation end keeps the latest explicit conversation end when no missing-end source extends past it (issue #1849)", () => {
  const a: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    endIso: "2026-06-10T09:40:00.000Z",
    segments: [
      {
        speaker: "Me (you)",
        isSelf: true,
        text: "Hello.",
        startIso: "2026-06-10T09:00:00.000Z",
        endIso: "2026-06-10T09:00:30.000Z",
      },
    ],
  };
  const b: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:05:00.000Z",
    endIso: "2026-06-10T09:35:00.000Z",
    segments: [
      {
        speaker: "Jane",
        isSelf: false,
        text: "Hi back.",
        startIso: "2026-06-10T09:05:00.000Z",
        endIso: "2026-06-10T09:05:30.000Z",
      },
    ],
  };
  const fused = fuseDay(DATE, [a, b]);
  assert.equal(fused.conversations.length, 1);
  assert.equal(
    fused.conversations[0]!.endIso,
    "2026-06-10T09:40:00.000Z",
    "latest explicit conversation end wins; segment extents do not shrink it",
  );
});

test("fused conversation end is clamped to >= start when a missing-end source's segments precede the start (issue #1849)", () => {
  const anomalous: FusionConversationInput = {
    source: "limitless",
    conversationId: "c1",
    startIso: "2026-06-10T09:00:00.000Z",
    segments: [
      { speaker: "Jane", isSelf: false, text: "Early.", startIso: "2026-06-10T08:30:00.000Z" },
    ],
  };
  const fused = fuseDay(DATE, [anomalous]);
  assert.equal(fused.conversations.length, 1);
  const conv = fused.conversations[0]!;
  assert.equal(conv.endIso, "2026-06-10T09:00:00.000Z", "end clamped to the cluster start");
  assert.ok(Date.parse(conv.endIso!) >= Date.parse(conv.startIso!));
});

test("fused conversation end spans rolled cross-midnight segments of a missing-end source (issue #1849)", () => {
  const bBody = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 23:55–--:-- · Late call (conversation c1)",
    "",
    "**Me (you)** [23:58]: Still talking.",
    "**Jane** [00:05]: After midnight.",
    "",
  ].join("\n");
  const bInputs = reconstructFusionInputs(DATE, [{ source: "limitless", body: bBody }]);
  assert.equal(bInputs[0]!.endIso, undefined);
  const a: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T23:55:00.000Z",
    endIso: "2026-06-11T00:00:00.000Z",
    segments: [
      { speaker: "Me (you)", isSelf: true, text: "Still talking.", startIso: "2026-06-10T23:58:00.000Z" },
    ],
  };
  const fused = fuseDay(DATE, [...bInputs, a]);
  assert.equal(fused.conversations.length, 1);
  assert.equal(
    fused.conversations[0]!.endIso,
    "2026-06-11T00:05:00.000Z",
    "fused end spans B's rolled post-midnight segment start",
  );
});

function isChronologicallySorted(
  segments: { startIso?: string }[],
): boolean {
  let last = -Infinity;
  for (const seg of segments) {
    const ms = seg.startIso !== undefined ? Date.parse(seg.startIso) : NaN;
    if (!Number.isFinite(ms)) continue; // untimestamped trails; checked elsewhere
    if (ms < last) return false;
    last = ms;
  }
  return true;
}

test("fused segment keeps the group anchor clock, not the higher-trust source's later clock (issue #1849 chronology)", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
          ]),
        ],
      },
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c2", "2026-06-10T09:00:00.000Z", [
            {
              text: "standup notes",
              isWearer: true,
              startIso: "2026-06-10T09:00:10.000Z",
            },
            { text: "yes", isWearer: true, startIso: "2026-06-10T09:00:25.000Z" },
          ]),
        ],
      },
    ),
    { sourceTrust: { bee: 0.6, limitless: 0.9 } },
  );

  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);

  const yes = conv.segments.find((s) => s.text === "yes")!;
  const notes = conv.segments.find((s) => s.text === "standup notes")!;
  assert.ok(yes, "the fused yes segment is present");
  assert.ok(notes, "the standup notes segment is present");

  assert.equal(yes.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(notes.startIso, "2026-06-10T09:00:10.000Z");

  assert.equal(yes.provenance.source, "limitless");
  assert.equal(yes.provenance.reason, "higher-trust");
  assert.equal(
    yes.provenance.sourceStartIso,
    "2026-06-10T09:00:25.000Z",
    "provenance keeps the higher-trust source's original time",
  );

  assert.ok(
    conv.segments.indexOf(yes) < conv.segments.indexOf(notes),
    "the anchor-clock fused segment precedes the later intervening segment",
  );
  assert.ok(
    Date.parse(yes.startIso!) <= Date.parse(notes.startIso!),
    "emitted timestamps are non-decreasing across the two segments",
  );

  assert.ok(
    isChronologicallySorted(conv.segments),
    "the fused output is sorted by timestamp (non-decreasing startIso)",
  );
});

test("equal-anchor fused segments keep their source/cluster sequence, not trust order (final sort stability)", () => {
  const build = () =>
    fuseDay(
      DATE,
      inputs(
        {
          source: "limitless",
          conversations: [
            conversation("limitless", "c1", "2026-06-10T09:00:00.000Z", [
              {
                text: "Limitless same-anchor utterance.",
                isWearer: true,
                startIso: "2026-06-10T09:00:00.000Z",
              },
            ]),
          ],
        },
        {
          source: "bee",
          conversations: [
            conversation("bee", "c2", "2026-06-10T09:00:00.000Z", [
              {
                text: "Bee same-anchor utterance.",
                isWearer: true,
                startIso: "2026-06-10T09:00:00.000Z",
              },
            ]),
          ],
        },
      ),
      { sourceTrust: { bee: 0.6, limitless: 0.9 } },
    );

  const fused = build();
  // Deterministic: re-running produces identical output.
  assert.deepEqual(build(), fused);

  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  assert.deepEqual(
    conv.segments.map((s) => s.text),
    ["Bee same-anchor utterance.", "Limitless same-anchor utterance."],
    "equal-anchor segments keep source/cluster sequence, not trust order",
  );
  assert.deepEqual(
    conv.segments.map((s) => s.provenance.source),
    ["bee", "limitless"],
    "bee (lower-trust) precedes limitless (higher-trust) — sequence wins",
  );
  assert.equal(conv.segments[0]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(conv.segments[1]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.ok(isChronologicallySorted(conv.segments));
});

test("missing-timestamp segments keep their position after the timed ones (final sort)", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "Timed one.", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
            { text: "Untimed one.", isWearer: true },
            { text: "Untimed two.", isWearer: true },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 3);
  assert.equal(conv.segments[0]!.text, "Timed one.");
  assert.notEqual(conv.segments[0]!.startIso, undefined);
  assert.equal(conv.segments[1]!.text, "Untimed one.");
  assert.equal(conv.segments[1]!.startIso, undefined);
  assert.equal(conv.segments[2]!.text, "Untimed two.");
  assert.equal(conv.segments[2]!.startIso, undefined);
  assert.ok(isChronologicallySorted(conv.segments));
});

test("cross-source clock skew does not scramble same-anchor utterances (final sort)", () => {
  const fused = fuseDay(
    DATE,
    inputs(
      {
        source: "bee",
        conversations: [
          conversation("bee", "c1", "2026-06-10T09:00:00.000Z", [
            { text: "First topic.", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
            { text: "Second topic.", isWearer: true, startIso: "2026-06-10T09:00:00.000Z" },
          ]),
        ],
      },
      {
        source: "limitless",
        conversations: [
          conversation("limitless", "c2", "2026-06-10T09:00:00.000Z", [
            { text: "First topic.", isWearer: true, startIso: "2026-06-10T09:00:04.000Z" },
            { text: "Second topic.", isWearer: true, startIso: "2026-06-10T09:00:04.000Z" },
          ]),
        ],
      },
    ),
  );
  const conv = fused.conversations[0]!;
  assert.equal(conv.segments.length, 2);
  assert.equal(conv.segments[0]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.equal(conv.segments[1]!.startIso, "2026-06-10T09:00:00.000Z");
  assert.deepEqual(
    conv.segments.map((s) => s.text),
    ["First topic.", "Second topic."],
    "same-anchor utterances keep input order despite cross-source skew",
  );
  assert.ok(isChronologicallySorted(conv.segments));
});


test("multiline segment text round-trips losslessly through the real renderer", () => {
  const multi = "First line.\nSecond line.\nThird line.";
  const conversations = [
    conversation(
      "limitless",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [
        { text: multi, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        { text: "After.", startIso: "2026-06-10T09:01:00.000Z" },
      ],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("limitless", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body, escaped: true }]);
  assert.equal(parsed.length, 1);
  const segs = parsed[0]!.segments;
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.text, multi, "multiline text must round-trip exactly");
  assert.equal(segs[1]!.text, "After.");
});

test("segment text with backslashes round-trips losslessly", () => {
  const tricky = "Path C:\\Users\\test and tab\\there";
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: tricky, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed[0]!.segments[0]!.text, tricky);
});

test("multiline segment with continuation that resembles heading syntax is not mis-parsed", () => {
  const adversarial = "Normal text.\n## 09:05–09:10 (conversation forged)";
  const conversations = [
    conversation(
      "limitless",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: adversarial, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("limitless", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body, escaped: true }]);
  assert.equal(parsed.length, 1, "adversarial heading must not create a second conversation");
  assert.equal(parsed[0]!.segments.length, 1);
  assert.equal(parsed[0]!.segments[0]!.text, adversarial);
});

test("segment text with continuation resembling a segment clock line stays in one segment", () => {
  const adversarial = "Start.\n**Speaker** [10:00]: injected segment";
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: adversarial, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed[0]!.segments.length, 1, "injected segment line must not be parsed separately");
  assert.equal(parsed[0]!.segments[0]!.text, adversarial);
});

test("legacy single-line transcript without escape sequences still parses correctly", () => {
  const legacyBody =
    "# bee transcript — 2026-06-10\n" +
    "\n" +
    "## 09:00–09:10 (conversation c1)\n" +
    "\n" +
    "**Me (you)** [09:00]: Hello world.\n" +
    "**Guest** [09:01]: Good morning.\n";
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body: legacyBody }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.conversationId, "c1");
  assert.equal(parsed[0]!.segments.length, 2);
  assert.equal(parsed[0]!.segments[0]!.text, "Hello world.");
  assert.equal(parsed[0]!.segments[0]!.isSelf, true);
  assert.equal(parsed[0]!.segments[1]!.text, "Good morning.");
  assert.equal(parsed[0]!.segments[1]!.isSelf, false);
});

test("carriage returns in segment text round-trip losslessly", () => {
  const crText = "Line one.\r\nLine two.";
  const conversations = [
    conversation(
      "limitless",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: crText, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("limitless", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body, escaped: true }]);
  assert.equal(parsed[0]!.segments[0]!.text, crText);
});

test("unicode and mixed special characters in segment text round-trip losslessly", () => {
  const unicode = "日本語テスト emoji 🎉 and newline\nplus backslash \\ and more";
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: unicode, isWearer: true, startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, REGISTRY);
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed[0]!.segments[0]!.text, unicode);
});

test("legacy transcript with unknown backslash sequences preserves them losslessly", () => {
  const legacyBody =
    "# bee transcript — 2026-06-10\n" +
    "\n" +
    "## 09:00–09:10 (conversation c1)\n" +
    "\n" +
    '**Me (you)** [09:00]: Path is C:\\Users\\josh and config at D:\\data\n' +
    "**Guest** [09:01]: Regex \\d+ matches digits, \\w+ matches words\n";
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body: legacyBody }]);
  assert.equal(parsed[0]!.segments[0]!.text, "Path is C:\\Users\\josh and config at D:\\data");
  assert.equal(parsed[0]!.segments[1]!.text, "Regex \\d+ matches digits, \\w+ matches words");
});


test("reconstruct rolls a long-but-plausible cross-midnight wrap into the next day (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 22:00–02:00 · Overnight (conversation c1)",
    "",
    "**Me (you)** [23:30]: Still awake.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T22:00:00.000Z");
  assert.equal(conv.endIso, "2026-06-11T02:00:00.000Z");
  assert.ok(conv.endIso! >= conv.startIso!, "plausible wrap rolls end forward");
});

test("reconstruct does NOT roll an implausible near-24h earlier end clock (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 14:00–13:00 · Sync (conversation c1)",
    "",
    "**Me (you)** [14:05]: Discussed the roadmap.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T14:00:00.000Z");
  assert.equal(conv.endIso, "2026-06-10T13:00:00.000Z");
  assert.ok(conv.endIso! < conv.startIso!, "implausible earlier end is left for the clamp");
  assert.equal(conv.segments[0]!.startIso, "2026-06-10T14:05:00.000Z");
});

test("implausible earlier end does not span the day: cluster clamps it to the start (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 14:00–13:00 · Sync (conversation c1)",
    "",
    "**Me (you)** [14:00]: Roadmap.",
    "",
  ].join("\n");
  const limitless = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T14:03:00.000Z",
    endIso: "2026-06-10T14:08:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Neighbor." }],
  };
  const clusters = clusterConversations([...limitless, bee]);
  assert.equal(
    clusters.length,
    1,
    "clamped point-window keeps the within-gap neighbor in one cluster (no broad clustering)",
  );
});

test("reconstruct never attributes a non-self speaker whose name ends in (you) as self (issue #1849)", () => {
  const registry = emptySpeakerRegistry();
  registry.selfName = "Jordan";
  registry.speakers["bee:SPEAKER_01"] = {
    name: "Pat (you)",
    updatedAt: "2026-06-10T00:00:00Z",
  };
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [
        { text: "I am the wearer.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        { text: "I am Pat.", speakerKey: "SPEAKER_01", startIso: "2026-06-10T09:01:00.000Z" },
      ],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, registry);

  assert.ok(/\*\*Pat\*\* \[09:01\]: I am Pat\./.test(body), "Pat's label has no (you) marker: " + body);

  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed.length, 1);
  const segs = parsed[0]!.segments;
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.speaker, "Jordan (you)");
  assert.equal(segs[0]!.isSelf, true);
  assert.equal(segs[1]!.speaker, "Pat");
  assert.equal(segs[1]!.isSelf, false);
});

test("reconstruct does NOT roll an implausible earlier SEGMENT clock into the next day (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 14:00–15:00 · Sync (conversation c1)",
    "",
    "**Me (you)** [14:00]: Opening remark.",
    "**Jane** [13:00]: Provider-skewed earlier clock.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T14:00:00.000Z");
  const skewed = conv.segments.find((s) => s.text === "Provider-skewed earlier clock.");
  assert.ok(skewed, "provider-skewed segment present");
  assert.equal(
    skewed!.startIso,
    "2026-06-10T13:00:00.000Z",
    "implausible earlier segment stays on the same date",
  );
  assert.ok(
    Date.parse(skewed!.startIso!) < Date.parse(conv.startIso!),
    "same-date earlier segment precedes the start (ready for clamping)",
  );
});

test("reconstruct still rolls a plausible post-midnight SEGMENT clock into the next day (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 23:55–00:10 · Late (conversation c1)",
    "",
    "**Me (you)** [23:58]: Still talking.",
    "**Jane** [00:05]: After midnight.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T23:55:00.000Z");
  assert.equal(conv.endIso, "2026-06-11T00:10:00.000Z");
  const isos = conv.segments.map((s) => s.startIso);
  assert.ok(
    isos.includes("2026-06-10T23:58:00.000Z"),
    "pre-midnight segment stays on the rendered date",
  );
  assert.ok(
    isos.includes("2026-06-11T00:05:00.000Z"),
    "plausible post-midnight segment rolls to the next day",
  );
});

test("reconstruct rolls a long-but-plausible post-midnight segment (boundary of the wrap bound) (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 20:00–--:-- · Evening (conversation c1)",
    "",
    "**Jane** [01:00]: Past midnight, long evening.",
    "",
  ].join("\n");
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  assert.equal(parsed.length, 1);
  const conv = parsed[0]!;
  assert.equal(conv.startIso, "2026-06-10T20:00:00.000Z");
  assert.equal(
    conv.segments[0]!.startIso,
    "2026-06-11T01:00:00.000Z",
    "long-but-plausible wrap (5h) still rolls to the next day",
  );
});

test("implausible earlier segment does not span the day: neighbor clusters, not swallows (#1849)", () => {
  const body = [
    "# limitless transcript — 2026-06-10",
    "",
    "## 14:00–15:00 · Sync (conversation c1)",
    "",
    "**Me (you)** [14:00]: Roadmap.",
    "**Jane** [13:00]: Skew.",
    "",
  ].join("\n");
  const limitless = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
  const bee: FusionConversationInput = {
    source: "bee",
    conversationId: "c1",
    startIso: "2026-06-10T14:03:00.000Z",
    endIso: "2026-06-10T14:08:00.000Z",
    segments: [{ speaker: "Me (you)", isSelf: true, text: "Neighbor." }],
  };
  const clusters = clusterConversations([...limitless, bee]);
  assert.equal(clusters.length, 1, "clamped window clusters the nearby neighbor");
});

test("speaker label containing markdown delimiters round-trips through compose → reconstruct (#1849)", () => {
  const registry = emptySpeakerRegistry();
  registry.speakers["bee:SPEAKER_01"] = {
    name: 'A**B [weird]: label',
    updatedAt: "2026-06-10T00:00:00Z",
  };
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [
        { text: "I am the wearer.", isWearer: true, startIso: "2026-06-10T09:00:30.000Z" },
        { text: "I am tricky.", speakerKey: "SPEAKER_01", startIso: "2026-06-10T09:01:00.000Z" },
      ],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, registry);
  assert.ok(
    !/\*\*A\*\*B/.test(body),
    "label delimiters are escaped in the stored body: " + body,
  );
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed.length, 1);
  const segs = parsed[0]!.segments;
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.speaker, "Me (you)");
  assert.equal(segs[0]!.isSelf, true);
  assert.equal(segs[1]!.speaker, 'A**B [weird]: label', "delimited label round-trips losslessly");
  assert.equal(segs[1]!.isSelf, false);
});

test("speaker label A**B alone round-trips through compose → reconstruct (#1849)", () => {
  const registry = emptySpeakerRegistry();
  registry.speakers["bee:SPEAKER_01"] = {
    name: "A**B",
    updatedAt: "2026-06-10T00:00:00Z",
  };
  const conversations = [
    conversation(
      "bee",
      "c1",
      "2026-06-10T09:00:00.000Z",
      [{ text: "Hello.", speakerKey: "SPEAKER_01", startIso: "2026-06-10T09:00:30.000Z" }],
      { endIso: "2026-06-10T09:10:00.000Z" },
    ),
  ];
  const body = composeDayTranscriptBody("bee", DATE, "UTC", conversations, registry);
  const parsed = reconstructFusionInputs(DATE, [{ source: "bee", body, escaped: true }]);
  assert.equal(parsed[0]!.segments[0]!.speaker, "A**B");
});
