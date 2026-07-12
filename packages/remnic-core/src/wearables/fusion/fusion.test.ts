import assert from "node:assert/strict";
import { test } from "node:test";

import { composeDayTranscriptBody } from "../day-store.js";
import { emptySpeakerRegistry } from "../speakers.js";
import type { WearableConversation } from "../types.js";
import {
  DEFAULT_PROXIMITY_GAP_MS,
  DEFAULT_WINDOW_TOLERANCE_MS,
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

/** Build a minimal wearable conversation with resolved self/others. */
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

test("content hash folds fusion config: same inputs, changed knob => new hash", () => {
  // Two contributing sources so per-source trust is part of the fingerprint.
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

  // A change to any clustering/reconciliation knob must invalidate the hash.
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

  // Idempotency is preserved: explicit defaults hash identically to omission,
  // and the per-conversation id stays stable across a config change.
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
  // Frontmatter carries a hash + count that would otherwise "match"; the
  // body itself must drive parseOk:false so fuseDay force-rewrites.
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
  // Non-array JSON, empty object, null, wrong-typed, and partial elements
  // are all rejected; a legitimately-empty [] is accepted.
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
  // ICU builds; reconstruct must never emit an invalid/next-day timestamp.
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
  // 24:00 -> 00:00 on the SAME date (not the next day); valid + parseable.
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
  // end clock 00:10 < start clock 23:55 -> rolled to the next calendar day.
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
  // A stored transcript whose heading end is unparseable (e.g. "--:--",
  // the rendered form of a missing endIso) must still roll a subsequent
  // segment whose clock precedes the start clock into the next calendar
  // day. The roll decision is driven by the segment-vs-start comparison,
  // not gated on a parseable heading end clock.
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
  // No parseable end clock -> no endIso is reconstructed.
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
  // The rolled segment must sort AFTER the conversation start so the
  // timeline ordering stays correct.
  const rolled = conv.segments.find((s) => s.startIso === "2026-06-11T00:05:00.000Z");
  assert.ok(rolled, "rolled segment present");
  assert.ok(
    Date.parse(rolled!.startIso!) > Date.parse(conv.startIso!),
    "segment ISO must sort after the start ISO",
  );
});

test("truncated high-trust text yields to a longer corroborating transcript", () => {
  // bee is the MORE trusted source but its text is a clipped prefix of
  // omi's full wording; the more-complete wording must win (not the trust).
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

test("distinct timestamped same-window utterances stay separate, not collapsed", () => {
  // Two sources capture genuinely different utterances inside the same
  // time window (within the alignment tolerance). They must NOT merge into
  // one segment — that would silently drop one source's content. Each
  // stays its own segment with its own provenance (consistent with the
  // untimestamped-collapse guard); the cross-source conflict is still
  // surfaced for review rather than silently resolved.
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
  // Provenance is preserved per segment — no source's content is lost.
  assert.deepEqual(
    conv.segments.map((s) => s.provenance.source).sort(),
    ["bee", "limitless"],
  );
  // The cross-source conflict is surfaced for review (not silently dropped).
  assert.equal(conv.disagreements.length, 1);
  assert.equal(conv.disagreements[0]!.candidates.length, 2);
});

test("equal-time same-source utterances keep original transcript order, not label order", () => {
  // From stored transcripts, segment times are minute-precision, so several
  // utterances from one source can share an identical anchorMs. The
  // alignment tie-break must preserve the ORIGINAL transcript sequence:
  // sorting equal-time segments by speaker label would scramble them
  // ("Amy" before "Zoe" even though Zoe spoke first).
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
  // Missing times all share the missing-anchor group; the tie-break must
  // still preserve original transcript sequence rather than speaker label.
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
  // Feed the actual renderer's output through reconstruct (not a hand-
  // written body) so renderer/parser drift is caught. The renderer emits
  // minute-precision clocks, so reconstructed ISOs zero the seconds.
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
  const parsed = reconstructFusionInputs(DATE, [{ source: "limitless", body }]);
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
  // Two cross-source conflicts where the bee source contributes TWO same-
  // speaker, same-length cands. bee1 and bee2 tie on every comparator key
  // (trust, text length, source) — only a STABLE secondary key keeps them
  // in input order. A comparator that returns nonzero for equal items (the
  // `a < b ? -1 : 1` antipattern) leaves their order undefined.
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
  // Deterministic: re-running produces identical output.
  assert.deepEqual(build(), fused);

  const conv = fused.conversations[0]!;
  // The three distinct same-window utterances stay separate and surface one
  // cross-segment ASR conflict.
  assert.equal(conv.segments.length, 3);
  const disagreement = conv.disagreements.find((d) => d.kind === "asr-text");
  assert.ok(disagreement, "a cross-segment asr-text disagreement is recorded");
  const values = disagreement!.candidates.map((c) => c.value);
  assert.equal(values.length, 3);
  // Stable: the two equal-key bee cands keep input order (bee1 before bee2),
  // never swapped by an unstable comparator.
  assert.ok(
    values.indexOf(textBee1) < values.indexOf(textBee2),
    "equal-key cands keep stable input order",
  );
});

test("same window + same text + different speaker fuses to one segment with a recorded speaker conflict", () => {
  // Two sources capture the same utterance in the same window but DISAGREE
  // on the speaker (Jane vs John). The same-speaker gate must not split
  // these into two segments: they corroborate on time+text, so they fuse
  // into ONE utterance and the speaker disagreement is recorded with
  // provenance for each label. (The r2 separation is about DIFFERENT text;
  // this is SAME text, different speaker.)
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
  // ONE fused segment — not two separate ones.
  assert.equal(conv.segments.length, 1);
  const segment = conv.segments[0]!;
  assert.equal(segment.text, text);
  // The higher-trust source's attribution wins provisionally.
  assert.equal(segment.speaker, "Jane");
  assert.equal(segment.isSelf, false);
  // A speaker conflict is recorded (not silently dropped).
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
  // Confidence is lowered by the unresolved speaker conflict.
  assert.ok(segment.confidence < 0.8);
  // No attribution is lost: both labels still appear in the speaker list.
  const labels = conv.speakers.filter((s) => !s.isSelf).map((s) => s.label);
  assert.ok(
    labels.includes("Jane") && labels.includes("John"),
    "both speaker labels are retained",
  );
});

test("cluster interval spans to the latest segment start when the conversation end is missing", () => {
  // A stored transcript renders a missing conversation end as "--:--".
  // reconstructFusionInputs rebuilds segments with only a startIso, so the
  // cluster interval must DERIVE its end from the latest segment start —
  // not collapse to a zero-length point at the conversation start. A later
  // conversation that sits within the proximity gap of the LAST segment
  // (but far past the start) must join the same cluster.
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
  // bee starts 3 min after the last limitless segment (09:33) — within the
  // 5-minute gap of 09:30, so it clusters. The old zero-length bug measured
  // the gap from 09:00 (33 min) and split them into two clusters.
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
  // The derived interval must be exactly [start, last segment start], not
  // unbounded. A neighbor 10 min past the last segment (> 5 min gap) must
  // NOT cluster with the missing-end conversation.
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
  // Cross-midnight segments in a missing-end conversation are rolled to the
  // next calendar day by reconstruct; the cluster interval end must reach
  // the rolled last segment so a post-midnight neighbor clusters correctly.
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
  // The latest segment rolled to 2026-06-11T00:05; a bee conversation at
  // 00:08 (3 min later) must cluster with it.
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
  // Directly constructed input proving the coherent model: when the
  // conversation end is absent and segments carry a MIX of endIso and
  // startIso, the window end is the maximum segment EXTENT (each segment's
  // end when known, else its start). Here the second segment's start
  // (09:20) must beat the first segment's end (09:10).
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
  // bee at 09:23 is within the 5-min gap of the derived end 09:20 -> one
  // cluster. If the interval had stopped at the first segment's END (09:10)
  // the gap would be 13 min and they would split.
  const clusters = clusterConversations([mixed, bee]);
  assert.equal(clusters.length, 1, "max segment extent (start beats earlier end) spans the window");
});

test("derived interval is clamped to end >= start for a missing-end conversation", () => {
  // Guarantee the [start, end] window is always valid: a conversation with
  // no end and only segments that somehow parse before the start still
  // yields end >= start (a point interval), never a negative-length window.
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
  // The conversation is emitted (not dropped) and forms a valid cluster.
  assert.equal(clusters[0]!.length, 1);
});
