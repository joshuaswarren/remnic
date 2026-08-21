import type {
  AssistantMemoryGraph,
  AssistantScenario,
} from "../_assistant-common/index.js";

const MULTI_DOC_GRAPH: AssistantMemoryGraph = {
  userHandle: "Alex Rivera",
  userRole: "staff engineer, tech-lead of Project Atlas",
  facts: [
    {
      id: "doc-1-perf-review",
      summary:
        "Performance review notes flagged Atlas read-heavy workloads as the top scaling bottleneck.",
      tags: ["scaling", "reads"],
    },
    {
      id: "doc-2-design-doc",
      summary:
        "Atlas design doc revision 4 proposes sharded read cache + event-log compaction as the next-quarter strategy.",
      tags: ["strategy"],
    },
    {
      id: "doc-3-incident",
      summary:
        "Last month's incident report attributed the outage to write-through cache thrashing under burst load.",
      tags: ["incident"],
    },
    {
      id: "doc-4-external-blog",
      summary:
        "An external blog post recommends aggressive write-through caching; the user pushed back on this in a comment thread.",
      tags: ["external"],
    },
    {
      id: "doc-5-1-1-notes",
      summary:
        "Alex's 1:1 notes with his manager emphasize predictable latency over raw throughput for Atlas.",
      tags: ["priorities"],
    },
  ],
  stances: [
    {
      topic: "Atlas caching strategy",
      position:
        "Alex has repeatedly argued for sharded read cache over expanded write-through caching.",
    },
    {
      topic: "latency vs throughput",
      position: "Alex prioritizes predictable latency over peak throughput.",
    },
  ],
  openThreads: [
    "Whether to merge the design-doc revision 4 before or after the Aurora commitment.",
  ],
};

export const ASSISTANT_SYNTHESIS_SCENARIOS: AssistantScenario[] = [
  {
    id: "synthesis.caching-view",
    title: "What does the brain think about Atlas caching?",
    focus: "multi_doc_synthesis",
    scenarioPrompt:
      "Across everything you've stored, what do I think is the right caching strategy for Atlas right now, and why? Give me a synthesized view, not a quote of any single document.",
    memoryGraph: MULTI_DOC_GRAPH,
  },
  {
    id: "synthesis.stance-disambiguation",
    title: "Stance disambiguation",
    focus: "stance_coherence",
    scenarioPrompt:
      "An external blog post is telling me write-through caching is the answer. How do I already think about that recommendation, based on what I've written before?",
    memoryGraph: MULTI_DOC_GRAPH,
  },
  {
    id: "synthesis.novelty-beyond-topk",
    title: "Beyond top-k regurgitation",
    focus: "novelty_vs_quote",
    scenarioPrompt:
      "Summarize my overall position on Atlas reliability in a single paragraph; do not quote any one document verbatim.",
    memoryGraph: MULTI_DOC_GRAPH,
  },
];

export const ASSISTANT_SYNTHESIS_SMOKE_SCENARIOS: AssistantScenario[] =
  ASSISTANT_SYNTHESIS_SCENARIOS.slice(0, 2);
