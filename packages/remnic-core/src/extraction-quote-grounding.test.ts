import assert from "node:assert/strict";
import test from "node:test";

import { quoteAnchors } from "./extraction-quote-grounding.js";
import { filterExtractionResultBySource } from "./extraction-source-grounding.js";
import type { ExtractionResult } from "./types.js";

// Minimal excerpts of a replayed dream run: the model's reworded `content` plus
// the exact `quote` it returned, over the source turns the quotes came from.
const TRAJECTORY_300_SOURCE = [
  "Historical trajectory 300, part 1/1. Task: you're given packets.pcap (subset of DAPT2020 traffic). "
    + "Compute the network statistics and fill in only the value column in network_stats.csv. "
    + "protocol_ip_total counts packets that contain an IP layer.",
  "Earlier attempt: the script created synthetic flows with missing ports for other protocols, and it "
    + "tried to include ICMPv6 packets in the ICMP counter, so IPv6 had to be excluded.",
  "Feedback for the next attempt: Use only the Scapy `IP` layer for `protocol_ip_total` and all IP-scoped "
    + "address, entropy, graph, PCR, port, and flow metrics; do not broaden these metrics to IPv6. "
    + "Construct unique five-tuples only from Scapy-`IP` TCP or UDP packets; do not synthesize zero-port "
    + "ICMP or other-protocol flows. For `bidirectional_flows`, require the exact reversed five-tuple and "
    + "count each distinct forward/reverse pair once rather than once per direction or via a separately "
    + "populated reverse-key set. Do not infer port scanning from the dataset name or an aggregate count of "
    + "many destination ports alone; require evidence that establishes aggressive scanning. Set "
    + "`is_traffic_benign` from the supported attack flags rather than from the dataset name. Count "
    + "`protocol_icmp` only when the Scapy `ICMP` layer is present; do not merge ICMPv6 classes into that "
    + "counter.",
].join("\n\n");

const TRAJECTORY_300_FACTS = [
  {
    content:
      "For the DAPT2020 network-statistics task, use only packets containing Scapy's IP layer for "
      + "protocol_ip_total and all IP-scoped address, entropy, graph, PCR, port, and flow metrics; exclude "
      + "IPv6 from these metrics.",
    quote:
      "Use only the Scapy `IP` layer for `protocol_ip_total` and all IP-scoped address, entropy, graph, "
      + "PCR, port, and flow metrics; do not broaden these metrics to IPv6.",
  },
  {
    content:
      "For the DAPT2020 network-statistics task, construct unique five-tuple flows only from TCP or UDP "
      + "packets containing Scapy's IP layer. Do not create flows with synthetic missing or zero ports for "
      + "ICMP or other protocols.",
    quote:
      "Construct unique five-tuples only from Scapy-`IP` TCP or UDP packets; do not synthesize zero-port "
      + "ICMP or other-protocol flows.",
  },
  {
    content:
      "For the DAPT2020 network-statistics task, bidirectional_flows requires an existing exact reversed "
      + "five-tuple and counts each distinct forward/reverse pair once, not once per direction or through a "
      + "separately populated reverse-key set.",
    quote:
      "For `bidirectional_flows`, require the exact reversed five-tuple and count each distinct "
      + "forward/reverse pair once rather than once per direction or via a separately populated "
      + "reverse-key set.",
  },
  {
    content:
      "For the DAPT2020 network-statistics task, flag malicious port scanning only when evidence "
      + "establishes aggressive scanning. The dataset name or an aggregate count of many destination ports "
      + "alone is insufficient.",
    quote:
      "Do not infer port scanning from the dataset name or an aggregate count of many destination ports "
      + "alone; require evidence that establishes aggressive scanning.",
  },
  {
    content:
      "For the DAPT2020 network-statistics task, derive is_traffic_benign from the supported attack flags "
      + "rather than the dataset name.",
    quote: "Set `is_traffic_benign` from the supported attack flags rather than from the dataset name.",
  },
  {
    content:
      "For the DAPT2020 network-statistics task, increment protocol_icmp only when Scapy's ICMP layer is "
      + "present; do not include ICMPv6 classes in that counter.",
    quote:
      "Count `protocol_icmp` only when the Scapy `ICMP` layer is present; do not merge ICMPv6 classes "
      + "into that counter.",
  },
];

const TRAJECTORY_376_SOURCE = [
  "Task: OAuth1 parameter serialization is broken. The headers must serialize percent-encoded names and "
    + "values as name=\"value\" pairs separated by commas. prepare_headers emits pairs with swapped names "
    + "and values and separates pairs only with spaces. The repaired implementation must reconstruct the URI "
    + "and keep the fix focused: do not introduce realm percent-encoding. The new module covers header "
    + "formatting, OAuth value escaping, filtering non-OAuth parameters, and preservation of supplied headers "
    + "and URI components.",
  "Expected format: percent-encoded name=\"value\" pairs, not swapped names and values. Analysis: The OAuth1 "
    + "parameter serialization bug has been fixed. Authorization headers now serialize "
    + "OAuth parameter names and values in the correct order and use RFC 5849 comma separators. URI query "
    + "signing now appends OAuth parameters while preserving scheme, authority/netloc, path, existing query "
    + "parameters, and fragment. The fix is in oauthlib/oauth1/rfc5849/parameters.py, where "
    + "prepare_request_uri_query calls _append_params(oauth_params, extract_params(query) or []) and "
    + "rebuilds the URI with urlunparse((sch, net, path, par, query, fra)).",
  "Plan: Update the test expectation for realm to preserve the existing unescaped quoted realm behavior "
    + "while still testing OAuth parameter escaping. Add a new tests/oauth1/rfc5849/test_parameters.py "
    + "with targeted header/query tests.",
].join("\n\n");

const TRAJECTORY_118_SOURCE = [
  "Request: I (James Wilson) and Carol White are working in the TechCorp Solutions Team, and we need to "
    + "sign off on the Q4 launch checklist. Then, start an audio-only call with Carol White so we can go "
    + "through the remaining blockers together. Start the call from my account: I want every call I ask "
    + "for to be logged under me as the caller.",
  "Workspace: the enterprise systems for this task are simulated.",
].join("\n\n");

function resultOf(
  facts: ReadonlyArray<{ content: string; quote?: string; entityRef?: string }>,
  extra: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    facts: facts.map((fact) => ({ category: "fact", confidence: 0.9, tags: [], ...fact })),
    profileUpdates: [],
    entities: [],
    questions: [],
    relationships: [],
    ...extra,
  };
}

function keptContents(result: ExtractionResult): string[] {
  return result.facts.map((fact) => fact.content);
}

test("trajectory 300: quote-valid reworded facts are kept, including quotes containing `;`", () => {
  const grounded = filterExtractionResultBySource(
    resultOf(TRAJECTORY_300_FACTS),
    TRAJECTORY_300_SOURCE,
    TRAJECTORY_300_SOURCE,
  );
  const [semicolonFact] = filterExtractionResultBySource(
    resultOf([{ ...TRAJECTORY_300_FACTS[0]!, entityRef: "Scapy" }]),
    TRAJECTORY_300_SOURCE,
    TRAJECTORY_300_SOURCE,
  ).facts;
  assert.equal(semicolonFact?.entityRef, "Scapy", "an anchored fact keeps an entityRef found in its quote window");
  assert.deepEqual(keptContents(grounded), TRAJECTORY_300_FACTS.map((fact) => fact.content));
});

test("trajectory 300: the same facts without their quote stay dropped by whole-source grounding", () => {
  const unquoted = TRAJECTORY_300_FACTS.map(({ content }) => ({ content }));
  const grounded = filterExtractionResultBySource(
    resultOf(unquoted),
    TRAJECTORY_300_SOURCE,
    TRAJECTORY_300_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("trajectory 376: quote-valid facts and the entity they support are kept", () => {
  const facts = [
    {
      content:
        "OAuth1 Authorization headers must serialize percent-encoded parameter names and values as "
        + "name=\"value\" pairs separated by commas, rather than swapping names and values or separating "
        + "pairs only with spaces.",
      quote:
        "Authorization headers now serialize OAuth parameter names and values in the correct order and "
        + "use RFC 5849 comma separators.",
    },
    {
      content:
        "In oauthlib/oauth1/rfc5849/parameters.py, prepare_request_uri_query must call "
        + "_append_params(oauth_params, extract_params(query) or []) and reconstruct the URI with "
        + "urlunparse((sch, net, path, par, query, fra)). The repaired implementation preserves URI "
        + "components while appending OAuth parameters.",
      quote:
        "URI query signing now appends OAuth parameters while preserving scheme, authority/netloc, path, "
        + "existing query parameters, and fragment.",
    },
    {
      content:
        "The oauthlib OAuth1 serialization repair preserves the existing unescaped, quoted realm behavior "
        + "instead of introducing realm percent-encoding, keeping the fix focused on parameter "
        + "serialization and separators.",
      quote:
        "Update the test expectation for realm to preserve the existing unescaped quoted realm behavior "
        + "while still testing OAuth parameter escaping.",
    },
    {
      content:
        "The oauthlib regression module tests/oauth1/rfc5849/test_parameters.py covers RFC 5849 "
        + "Authorization header formatting and URI query component preservation.",
      quote: "Add a new tests/oauth1/rfc5849/test_parameters.py with targeted header/query tests.",
    },
  ];
  const grounded = filterExtractionResultBySource(
    resultOf(facts, {
      entities: [
        {
          name: "oauthlib",
          type: "project",
          facts: ["Its OAuth1 parameter handling implementation is located in oauthlib/oauth1/rfc5849/parameters.py."],
          structuredSections: [
            {
              key: "oauth1-parameter-handling",
              title: "OAuth1 Parameter Handling",
              facts: [
                "URI query serialization preserves URI components and appends OAuth parameters after existing request parameters.",
                "Authorization headers use correctly ordered, percent-encoded parameter names and values with comma separators.",
              ],
            },
          ],
        },
      ],
    }),
    TRAJECTORY_376_SOURCE,
    TRAJECTORY_376_SOURCE,
  );
  assert.equal(grounded.facts.length, 4);
  assert.equal(grounded.entities.length, 1);
  assert.equal(grounded.entities[0]!.structuredSections?.[0]?.facts.length, 2);
});

test("trajectory 118, part 1: quote-valid facts, entities and relationships are kept", () => {
  const grounded = filterExtractionResultBySource(
    resultOf(
      [
        {
          content: "James Wilson wants every call he requests to originate from his account and be logged with him as the caller.",
          quote: "Start the call from my account: I want every call I ask for to be logged under me as the caller.",
        },
        {
          content: "James Wilson and Carol White work together in the TechCorp Solutions Team.",
          quote: "I (James Wilson) and Carol White are working in the TechCorp Solutions Team",
        },
      ],
      {
        entities: [
          {
            name: "carol-white",
            type: "person",
            facts: ["Carol White works with James Wilson in the TechCorp Solutions Team."],
          },
        ],
        relationships: [
          { source: "james-wilson", target: "techcorp-solutions-team", label: "works in" },
          { source: "james-wilson", target: "carol-white", label: "works with in the TechCorp Solutions Team" },
        ],
      },
    ),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 2);
  assert.deepEqual(grounded.entities.map((entity) => entity.name), ["carol-white"]);
  assert.equal(grounded.relationships?.length, 2);
});

test("a fabricated quote does not anchor anything", () => {
  const grounded = filterExtractionResultBySource(
    resultOf([
      {
        content: "James Wilson requires every call to be approved by a manager before it starts.",
        quote: "Every call must be approved by a manager before it starts.",
      },
    ]),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("a real quote does not vouch for content that is about something else", () => {
  const grounded = filterExtractionResultBySource(
    resultOf([
      {
        content: "The nightly backup job copies the database snapshot to cold storage.",
        quote: "Start the call from my account: I want every call I ask for to be logged under me as the caller.",
      },
    ]),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("a real quote does not vouch for content padded with words the source never used", () => {
  const grounded = filterExtractionResultBySource(
    resultOf([
      {
        content:
          "James Wilson wants every call logged under his account, and finance reimburses encrypted "
          + "satellite roaming surcharges quarterly through procurement.",
        quote: "Start the call from my account: I want every call I ask for to be logged under me as the caller.",
      },
    ]),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("a quote too short to be evidence does not anchor", () => {
  const grounded = filterExtractionResultBySource(
    resultOf([
      { content: "James Wilson owns the Q4 budget.", quote: "the caller" },
    ]),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("a quote stitched across two turns is not one turn's words", () => {
  const stitched = "logged under me as the caller. Workspace: the enterprise systems for this task are simulated.";
  assert.deepEqual(quoteAnchors(stitched, TRAJECTORY_118_SOURCE), []);
  const grounded = filterExtractionResultBySource(
    resultOf([
      { content: "Calls the caller logs are simulated by the enterprise systems for this task.", quote: stitched },
    ]),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 0);
});

test("entities and relationships need a kept quote: none is kept beside a fabricated quote", () => {
  const grounded = filterExtractionResultBySource(
    resultOf(
      [
        {
          content: "James Wilson and Carol White work together in the TechCorp Solutions Team.",
          quote: "James Wilson and Carol White both report to the TechCorp Solutions Team lead.",
        },
      ],
      {
        entities: [
          {
            name: "carol-white",
            type: "person",
            facts: ["Carol White works with James Wilson in the TechCorp Solutions Team."],
          },
        ],
        relationships: [{ source: "james-wilson", target: "carol-white", label: "works with" }],
      },
    ),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.entities.length, 0);
  assert.equal(grounded.relationships?.length, 0);
});

test("entity facts and relationships unsupported by the anchor window are rejected", () => {
  const grounded = filterExtractionResultBySource(
    resultOf(
      [
        {
          content: "James Wilson and Carol White work together in the TechCorp Solutions Team.",
          quote: "I (James Wilson) and Carol White are working in the TechCorp Solutions Team",
        },
      ],
      {
        entities: [
          {
            name: "carol-white",
            type: "person",
            facts: ["Carol White approves the quarterly travel budget for the whole organization."],
          },
        ],
        relationships: [{ source: "carol-white", target: "initech-corporation", label: "works in" }],
      },
    ),
    TRAJECTORY_118_SOURCE,
    TRAJECTORY_118_SOURCE,
  );
  assert.equal(grounded.facts.length, 1);
  assert.equal(grounded.entities.length, 0);
  assert.equal(grounded.relationships?.length, 0);
});

test("quoteAnchors matches across whitespace differences and keeps the window inside its turn", () => {
  const anchors = quoteAnchors("Start the call   from my\naccount:", TRAJECTORY_118_SOURCE);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]!.quote, "Start the call from my account:");
  assert.ok(anchors[0]!.window.includes("audio-only call with Carol White"));
  assert.ok(!anchors[0]!.window.includes("Workspace:"));
});

test("quoteAnchors keeps a quote with `;` as one sentence", () => {
  const [anchor] = quoteAnchors(
    "Construct unique five-tuples only from Scapy-`IP` TCP or UDP packets; do not synthesize zero-port ICMP or other-protocol flows.",
    TRAJECTORY_300_SOURCE,
  );
  assert.ok(anchor !== undefined);
  assert.ok(anchor.quote.includes(";"));
  assert.ok(anchor.window.includes("packets, do not synthesize"));
});
