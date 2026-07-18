# Ingestion Benchmark Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Ingestion axis to the bench suite — inbox fixtures, entity recall, backlink F1, citation accuracy, schema completeness, and setup friction metrics.

**Architecture:** New `IngestionBenchAdapter` interface separate from retrieval's `BenchMemoryAdapter`. Synthetic inbox fixtures (email, project-folder, calendar, chat) each ship a gold graph. Five benchmark runners score ingested memory against gold graphs. Vertical PR slices — each PR is independently shippable.

**Tech Stack:** TypeScript (ES2022, ESM), tsup, existing `@remnic/bench` scorer utilities.

**Spec:** `docs/superpowers/specs/2026-04-18-ingestion-benchmarks-design.md`

---

## File Structure

```
packages/bench/src/
├── ingestion-types.ts                              # Gold graph, adapter, log types
├── ingestion-scorer.ts                             # Entity matching, link matching, frontmatter checking
├── fixtures/
│   └── inbox/
│       ├── types.ts                                # FixtureOutput, FixtureGenerator types
│       ├── email.ts                                # Synthetic email generator
│       ├── email-gold.ts                           # Gold graph for email corpus
│       ├── project-folder.ts                       # Synthetic project folder generator
│       ├── project-folder-gold.ts                  # Gold graph for project folder
│       ├── calendar.ts                             # Synthetic ICS generator
│       ├── calendar-gold.ts                        # Gold graph for calendar
│       ├── chat.ts                                 # Synthetic chat transcript generator
│       └── chat-gold.ts                            # Gold graph for chat
└── benchmarks/
    └── remnic/
        ├── ingestion-entity-recall/
        │   └── runner.ts
        ├── ingestion-backlink-f1/
        │   └── runner.ts
        ├── ingestion-citation-accuracy/
        │   └── runner.ts
        ├── ingestion-schema-completeness/
        │   └── runner.ts
        └── ingestion-setup-friction/
            └── runner.ts
```

---

## PR 1: Ingestion Types and Adapter Interface

### Task 1: Add ingestion types

**Files:**
- Create: `packages/bench/src/ingestion-types.ts`

- [ ] **Step 1: Create ingestion-types.ts with all type definitions**

```typescript
/**
 * Types for the ingestion benchmark tier.
 */

// --- Gold graph (curated ground truth shipped with each fixture) ---

export type GoldEntityType = "person" | "org" | "project" | "topic" | "event" | "location";

export interface GoldEntity {
  id: string;
  name: string;
  type: GoldEntityType;
  aliases?: string[];
}

export interface GoldLink {
  source: string;
  target: string;
  relation: string;
  bidirectional: boolean;
}

export interface GoldPage {
  title: string;
  requiredFields: string[];
  expectTimeline: boolean;
  expectExecSummary: boolean;
  expectSeeAlso: string[];
}

export interface GoldGraph {
  entities: GoldEntity[];
  links: GoldLink[];
  pages: GoldPage[];
}

// --- Extracted memory graph (what the system actually produced) ---

export interface ExtractedEntity {
  name: string;
  type: string;
  sourceFile: string;
}

export interface ExtractedLink {
  source: string;
  target: string;
  relation: string;
}

export interface ExtractedPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  hasExecSummary: boolean;
  hasTimeline: boolean;
  seeAlso: string[];
  content: string;
}

export interface MemoryGraph {
  entities: ExtractedEntity[];
  links: ExtractedLink[];
  pages: ExtractedPage[];
}

// --- Ingestion log (tracks human intervention for setup-friction metric) ---

export interface IngestionLog {
  commandsIssued: string[];
  promptsShown: string[];
  errors: string[];
  durationMs: number;
}

// --- Adapter contract ---

export interface IngestionBenchAdapter {
  ingest(inputDir: string): Promise<IngestionLog>;
  getMemoryGraph(): Promise<MemoryGraph>;
  reset(): Promise<void>;
  destroy(): Promise<void>;
}

// --- Canonical frontmatter schema for completeness rubric ---

export const REQUIRED_FRONTMATTER_FIELDS = ["title", "type", "state", "created", "see-also"] as const;

export const CONDITIONAL_FRONTMATTER: Record<string, { field: string; requiredWhen: GoldEntityType[] }[]> = {
  "exec-summary": [{ field: "exec-summary", requiredWhen: ["project", "org", "event"] }],
  timeline: [{ field: "timeline", requiredWhen: ["project", "event"] }],
};
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd ~/src/remnic && npx tsc --noEmit packages/bench/src/ingestion-types.ts --target ES2022 --module ESNext --moduleResolution bundler --strict`

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/ingestion-types.ts
git commit -m "bench: add ingestion types and adapter interface

Foundation types for the ingestion benchmark tier: GoldGraph for
fixture ground truth, IngestionBenchAdapter contract, MemoryGraph
for extracted results, and canonical frontmatter schema constants."
```

### Task 2: Add "ingestion" to BenchmarkCategory

**Files:**
- Modify: `packages/bench/src/types.ts:8`

- [ ] **Step 1: Add "ingestion" to BenchmarkCategory union**

In `packages/bench/src/types.ts`, change line 8 from:

```typescript
export type BenchmarkCategory = "agentic" | "retrieval" | "conversational";
```

to:

```typescript
export type BenchmarkCategory = "agentic" | "retrieval" | "conversational" | "ingestion";
```

- [ ] **Step 2: Update LegacyBenchmarkMeta category in adapters/types.ts**

In `packages/bench/src/adapters/types.ts`, change line 54 from:

```typescript
  category: "agentic" | "retrieval" | "conversational";
```

to:

```typescript
  category: "agentic" | "retrieval" | "conversational" | "ingestion";
```

- [ ] **Step 3: Verify types compile**

Run: `cd ~/src/remnic/packages/bench && npx tsc --noEmit`

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/types.ts packages/bench/src/adapters/types.ts
git commit -m "bench: add ingestion category to BenchmarkCategory type"
```

### Task 3: Export ingestion types from package index

**Files:**
- Modify: `packages/bench/src/index.ts`

- [ ] **Step 1: Add ingestion type exports to index.ts**

Add after the existing adapter type exports (after line 42):

```typescript
export type {
  GoldEntityType,
  GoldEntity,
  GoldLink,
  GoldPage,
  GoldGraph,
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  MemoryGraph,
  IngestionLog,
  IngestionBenchAdapter,
} from "./ingestion-types.js";

export { REQUIRED_FRONTMATTER_FIELDS, CONDITIONAL_FRONTMATTER } from "./ingestion-types.js";
```

- [ ] **Step 2: Add ingestion-types.ts to tsconfig include**

In `packages/bench/tsconfig.json`, add `"src/ingestion-types.ts"` to the `include` array.

- [ ] **Step 3: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build, `dist/ingestion-types.js` and `dist/ingestion-types.d.ts` produced

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/index.ts packages/bench/tsconfig.json
git commit -m "bench: export ingestion types from package index"
```

### Task 4: Add fixture types

**Files:**
- Create: `packages/bench/src/fixtures/inbox/types.ts`

- [ ] **Step 1: Create fixture types**

```typescript
/**
 * Shared types for inbox fixture generators.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export interface GeneratedFile {
  relativePath: string;
  content: string;
}

export interface FixtureOutput {
  id: string;
  description: string;
  files: GeneratedFile[];
  goldGraph: GoldGraph;
}

export interface FixtureGenerator {
  id: string;
  description: string;
  generate(): FixtureOutput;
}
```

- [ ] **Step 2: Export fixture types from index**

Add to `packages/bench/src/index.ts`:

```typescript
export type {
  GeneratedFile,
  FixtureOutput,
  FixtureGenerator,
} from "./fixtures/inbox/types.js";
```

- [ ] **Step 3: Add fixtures path to tsconfig include**

In `packages/bench/tsconfig.json`, add `"src/fixtures/**/*.ts"` to the `include` array.

- [ ] **Step 4: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/fixtures/inbox/types.ts packages/bench/src/index.ts packages/bench/tsconfig.json
git commit -m "bench: add fixture types for inbox generators"
```

---

## PR 2: Email Fixture Generator

### Task 5: Create email fixture generator

**Files:**
- Create: `packages/bench/src/fixtures/inbox/email.ts`
- Create: `packages/bench/src/fixtures/inbox/email-gold.ts`

- [ ] **Step 1: Create the gold graph for the email corpus**

```typescript
/**
 * Gold graph for the synthetic email fixture.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const EMAIL_GOLD_GRAPH: GoldGraph = {
  entities: [
    { id: "p-sarah", name: "Sarah Chen", type: "person", aliases: ["Sarah", "S. Chen"] },
    { id: "p-marcus", name: "Marcus Rivera", type: "person", aliases: ["Marcus", "M. Rivera"] },
    { id: "p-elena", name: "Elena Volkov", type: "person", aliases: ["Elena", "E. Volkov"] },
    { id: "p-james", name: "James Okafor", type: "person", aliases: ["James", "J. Okafor"] },
    { id: "p-priya", name: "Priya Sharma", type: "person", aliases: ["Priya", "P. Sharma"] },
    { id: "p-david", name: "David Kim", type: "person", aliases: ["David", "D. Kim"] },
    { id: "p-anna", name: "Anna Lindqvist", type: "person", aliases: ["Anna", "A. Lindqvist"] },
    { id: "p-tom", name: "Tom Nakamura", type: "person", aliases: ["Tom", "T. Nakamura"] },
    { id: "o-nexus", name: "Nexus Technologies", type: "org", aliases: ["Nexus", "Nexus Tech"] },
    { id: "o-meridian", name: "Meridian Partners", type: "org", aliases: ["Meridian"] },
    { id: "o-atlas", name: "Atlas Consulting", type: "org", aliases: ["Atlas"] },
    { id: "proj-horizon", name: "Project Horizon", type: "project", aliases: ["Horizon"] },
    { id: "proj-beacon", name: "Project Beacon", type: "project", aliases: ["Beacon"] },
    { id: "t-q3-budget", name: "Q3 Budget Review", type: "topic" },
    { id: "e-launch", name: "Horizon Launch Event", type: "event", aliases: ["launch event", "launch"] },
  ],
  links: [
    { source: "p-sarah", target: "o-nexus", relation: "works-at", bidirectional: false },
    { source: "p-marcus", target: "o-nexus", relation: "works-at", bidirectional: false },
    { source: "p-elena", target: "o-meridian", relation: "works-at", bidirectional: false },
    { source: "p-james", target: "o-atlas", relation: "works-at", bidirectional: false },
    { source: "p-priya", target: "o-nexus", relation: "works-at", bidirectional: false },
    { source: "p-sarah", target: "proj-horizon", relation: "leads", bidirectional: false },
    { source: "p-marcus", target: "proj-horizon", relation: "contributes-to", bidirectional: false },
    { source: "p-elena", target: "proj-horizon", relation: "advises", bidirectional: false },
    { source: "p-david", target: "proj-beacon", relation: "leads", bidirectional: false },
    { source: "p-tom", target: "proj-beacon", relation: "contributes-to", bidirectional: false },
    { source: "proj-horizon", target: "e-launch", relation: "milestone", bidirectional: false },
    { source: "p-anna", target: "t-q3-budget", relation: "presents", bidirectional: false },
    { source: "p-sarah", target: "p-elena", relation: "collaborates-with", bidirectional: true },
    { source: "p-marcus", target: "p-priya", relation: "collaborates-with", bidirectional: true },
  ],
  pages: [
    { title: "Sarah Chen", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: false, expectExecSummary: false, expectSeeAlso: ["Project Horizon", "Nexus Technologies"] },
    { title: "Project Horizon", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: true, expectExecSummary: true, expectSeeAlso: ["Sarah Chen", "Nexus Technologies", "Horizon Launch Event"] },
    { title: "Nexus Technologies", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: false, expectExecSummary: true, expectSeeAlso: ["Sarah Chen", "Marcus Rivera", "Project Horizon"] },
  ],
};
```

- [ ] **Step 2: Create the email generator**

```typescript
/**
 * Synthetic email fixture generator.
 *
 * Produces mbox-style output with threads, forwards, and quoted text.
 * All names, orgs, and projects are synthetic — no real PII.
 */

import type { FixtureGenerator, FixtureOutput, GeneratedFile } from "./types.js";
import { EMAIL_GOLD_GRAPH } from "./email-gold.js";

interface EmailMessage {
  messageId: string;
  inReplyTo?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  date: string;
  body: string;
}

const THREADS: EmailMessage[][] = [
  // Thread 1: Project Horizon kickoff (Sarah, Marcus, Elena)
  [
    {
      messageId: "<horizon-001@nexus.test>",
      from: "Sarah Chen <sarah.chen@nexus.test>",
      to: ["Marcus Rivera <marcus.rivera@nexus.test>", "Elena Volkov <elena.volkov@meridian.test>"],
      subject: "Project Horizon — Kickoff",
      date: "Mon, 15 Jan 2026 09:00:00 +0000",
      body: "Hi Marcus, Elena,\n\nI'm kicking off Project Horizon — our new analytics platform for Nexus Technologies. Elena, Meridian Partners will be advising on the go-to-market strategy.\n\nKey milestones:\n- Sprint 1 complete by Feb 15\n- Beta launch March 1\n- Horizon Launch Event on March 15\n\nLet's sync this week.\n\nBest,\nSarah",
    },
    {
      messageId: "<horizon-002@nexus.test>",
      inReplyTo: "<horizon-001@nexus.test>",
      from: "Marcus Rivera <marcus.rivera@nexus.test>",
      to: ["Sarah Chen <sarah.chen@nexus.test>"],
      cc: ["Elena Volkov <elena.volkov@meridian.test>"],
      subject: "Re: Project Horizon — Kickoff",
      date: "Mon, 15 Jan 2026 10:30:00 +0000",
      body: "Sarah,\n\nSounds great. I'll pull in Priya Sharma for the data pipeline work — she's been doing excellent work on our ingestion layer at Nexus.\n\nI'll have the Sprint 1 plan ready by Wednesday.\n\n— Marcus",
    },
    {
      messageId: "<horizon-003@meridian.test>",
      inReplyTo: "<horizon-002@nexus.test>",
      from: "Elena Volkov <elena.volkov@meridian.test>",
      to: ["Sarah Chen <sarah.chen@nexus.test>", "Marcus Rivera <marcus.rivera@nexus.test>"],
      subject: "Re: Project Horizon — Kickoff",
      date: "Mon, 15 Jan 2026 14:15:00 +0000",
      body: "Sarah, Marcus,\n\nMeridian is excited to advise on Horizon. I'll prepare the competitive landscape analysis by end of next week.\n\nOne question — is James Okafor at Atlas Consulting still handling the security audit?\n\nBest,\nElena",
    },
  ],
  // Thread 2: Q3 Budget (Anna, Sarah)
  [
    {
      messageId: "<budget-001@nexus.test>",
      from: "Anna Lindqvist <anna.lindqvist@nexus.test>",
      to: ["Sarah Chen <sarah.chen@nexus.test>"],
      subject: "Q3 Budget Review — Action Items",
      date: "Wed, 05 Feb 2026 11:00:00 +0000",
      body: "Sarah,\n\nFollowing up on the Q3 Budget Review meeting. Here are the key takeaways:\n\n1. Project Horizon gets an additional $50K for cloud infrastructure\n2. Project Beacon (David Kim's team) budget held flat\n3. Training budget increased 15% across all departments\n\nI'll present the final numbers at next week's all-hands.\n\n— Anna",
    },
  ],
  // Thread 3: Project Beacon status (David, Tom)
  [
    {
      messageId: "<beacon-001@nexus.test>",
      from: "David Kim <david.kim@nexus.test>",
      to: ["Tom Nakamura <tom.nakamura@nexus.test>"],
      subject: "Beacon — Sprint Review",
      date: "Thu, 06 Feb 2026 16:00:00 +0000",
      body: "Tom,\n\nGood sprint. The new monitoring dashboard is looking solid. Let's demo it to the team on Friday.\n\nAlso, I talked to Sarah about cross-pollinating ideas between Beacon and Horizon. There might be shared components we can reuse.\n\n— David",
    },
    {
      messageId: "<beacon-002@nexus.test>",
      inReplyTo: "<beacon-001@nexus.test>",
      from: "Tom Nakamura <tom.nakamura@nexus.test>",
      to: ["David Kim <david.kim@nexus.test>"],
      subject: "Re: Beacon — Sprint Review",
      date: "Thu, 06 Feb 2026 17:30:00 +0000",
      body: "David,\n\nGreat idea on the shared components. I'll prepare the demo for Friday.\n\nThe logging module could definitely be reused in Project Horizon — I'll flag it for Marcus.\n\n— Tom",
    },
  ],
  // Thread 4: Security audit (James, Sarah) — forwarded
  [
    {
      messageId: "<audit-001@atlas.test>",
      from: "James Okafor <james.okafor@atlas.test>",
      to: ["Sarah Chen <sarah.chen@nexus.test>"],
      subject: "Fwd: Horizon Security Audit — Initial Findings",
      date: "Fri, 07 Feb 2026 09:00:00 +0000",
      body: "Sarah,\n\nForwarding the initial security audit findings from Atlas Consulting for Project Horizon.\n\nSummary:\n- Authentication layer: PASS\n- Data encryption at rest: PASS\n- API rate limiting: NEEDS WORK — recommend implementing token bucket\n- Input validation: PASS with minor recommendations\n\nFull report attached. Happy to discuss next week.\n\nBest,\nJames Okafor\nAtlas Consulting",
    },
  ],
  // Thread 5: Launch event planning (Sarah, Priya, Marcus)
  [
    {
      messageId: "<launch-001@nexus.test>",
      from: "Priya Sharma <priya.sharma@nexus.test>",
      to: ["Sarah Chen <sarah.chen@nexus.test>", "Marcus Rivera <marcus.rivera@nexus.test>"],
      subject: "Horizon Launch Event — Logistics",
      date: "Mon, 10 Feb 2026 13:00:00 +0000",
      body: "Sarah, Marcus,\n\nI've started coordinating the Horizon Launch Event for March 15. Here's what I need:\n\n1. Demo environment ready by March 10\n2. Guest list finalized by March 1 — Elena mentioned Meridian wants to invite 5 clients\n3. Venue confirmed: Nexus HQ, Building C, Floor 3\n\nMarcus — can you handle the technical demo setup?\n\n— Priya",
    },
    {
      messageId: "<launch-002@nexus.test>",
      inReplyTo: "<launch-001@nexus.test>",
      from: "Marcus Rivera <marcus.rivera@nexus.test>",
      to: ["Priya Sharma <priya.sharma@nexus.test>"],
      cc: ["Sarah Chen <sarah.chen@nexus.test>"],
      subject: "Re: Horizon Launch Event — Logistics",
      date: "Mon, 10 Feb 2026 14:45:00 +0000",
      body: "Priya,\n\nI'll have the demo environment ready by March 8 — two days buffer. Tom from Beacon offered to help with the AV setup since they just did a similar demo.\n\nI'll coordinate with Elena on the Meridian guest list.\n\n— Marcus",
    },
  ],
];

function formatMboxMessage(msg: EmailMessage): string {
  const headers = [
    `From ${msg.from.replace(/<.*>/, "").trim()} ${msg.date}`,
    `Message-ID: ${msg.messageId}`,
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : null,
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
    msg.cc ? `Cc: ${msg.cc.join(", ")}` : null,
    `Subject: ${msg.subject}`,
    `Date: ${msg.date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ]
    .filter(Boolean)
    .join("\n");

  return `${headers}\n\n${msg.body}\n`;
}

function generateMbox(): string {
  const messages = THREADS.flat();
  return messages.map(formatMboxMessage).join("\n");
}

export const emailFixture: FixtureGenerator = {
  id: "email",
  description: "Synthetic mbox email corpus with 5 threads, 8 people, 3 orgs, 2 projects",

  generate(): FixtureOutput {
    const mboxContent = generateMbox();

    const files: GeneratedFile[] = [
      { relativePath: "inbox.mbox", content: mboxContent },
    ];

    return {
      id: "email",
      description: this.description,
      files,
      goldGraph: EMAIL_GOLD_GRAPH,
    };
  },
};
```

- [ ] **Step 3: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/fixtures/inbox/email.ts packages/bench/src/fixtures/inbox/email-gold.ts
git commit -m "bench: add synthetic email fixture generator

20 messages across 5 threads with 8 people, 3 orgs, 2 projects.
Mbox format with threads, forwards, CCs, and quoted text.
Includes gold graph with entities, links, and expected pages."
```

---

## PR 3: Entity Recall Benchmark

### Task 6: Add ingestion scorer utilities

**Files:**
- Create: `packages/bench/src/ingestion-scorer.ts`

- [ ] **Step 1: Create ingestion scoring utilities**

```typescript
/**
 * Scoring utilities for ingestion benchmarks.
 */

import type {
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  GoldEntity,
  GoldLink,
  GoldPage,
} from "./ingestion-types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
}

function entityNameMatches(extracted: string, gold: GoldEntity): boolean {
  const normalizedExtracted = normalize(extracted);
  if (normalizedExtracted === normalize(gold.name)) return true;
  if (gold.aliases) {
    return gold.aliases.some((alias) => normalize(alias) === normalizedExtracted);
  }
  return false;
}

export function matchEntity(extracted: ExtractedEntity, gold: GoldEntity): boolean {
  return (
    normalize(extracted.type) === normalize(gold.type) &&
    entityNameMatches(extracted.name, gold)
  );
}

export function entityRecall(
  extracted: ExtractedEntity[],
  gold: GoldEntity[],
): { overall: number; byType: Record<string, number> } {
  if (gold.length === 0) return { overall: 1, byType: {} };

  const matched = new Set<string>();
  for (const ge of gold) {
    if (extracted.some((ee) => matchEntity(ee, ge))) {
      matched.add(ge.id);
    }
  }

  const overall = matched.size / gold.length;

  const typeGroups = new Map<string, GoldEntity[]>();
  for (const ge of gold) {
    const group = typeGroups.get(ge.type) ?? [];
    group.push(ge);
    typeGroups.set(ge.type, group);
  }

  const byType: Record<string, number> = {};
  for (const [type, entities] of typeGroups) {
    const typeMatched = entities.filter((ge) => matched.has(ge.id)).length;
    byType[`${type}_recall`] = typeMatched / entities.length;
  }

  return { overall, byType };
}

export function linkMatches(extracted: ExtractedLink, gold: GoldLink): boolean {
  const sourceMatch =
    normalize(extracted.source) === normalize(gold.source) ||
    normalize(extracted.source) === normalize(gold.target);
  const targetMatch =
    normalize(extracted.target) === normalize(gold.target) ||
    normalize(extracted.target) === normalize(gold.source);

  if (gold.bidirectional) {
    return sourceMatch && targetMatch && normalize(extracted.relation) === normalize(gold.relation);
  }

  return (
    normalize(extracted.source) === normalize(gold.source) &&
    normalize(extracted.target) === normalize(gold.target) &&
    normalize(extracted.relation) === normalize(gold.relation)
  );
}

export function backlinkF1(
  extracted: ExtractedLink[],
  gold: GoldLink[],
): { precision: number; recall: number; f1: number } {
  if (gold.length === 0 && extracted.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  if (extracted.length === 0) return { precision: 0, recall: 0, f1: 0 };
  if (gold.length === 0) return { precision: 0, recall: 0, f1: 0 };

  const matchedGold = new Set<number>();
  let correctExtracted = 0;
  for (const el of extracted) {
    for (let gi = 0; gi < gold.length; gi++) {
      if (!matchedGold.has(gi) && linkMatches(el, gold[gi]!)) {
        matchedGold.add(gi);
        correctExtracted++;
        break;
      }
    }
  }

  const precision = correctExtracted / extracted.length;
  const recall = matchedGold.size / gold.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

export function schemaCompleteness(
  pages: ExtractedPage[],
  goldPages: GoldPage[],
  requiredFields: readonly string[],
): { overall: number; fieldCoverage: Record<string, number> } {
  if (goldPages.length === 0) return { overall: 1, fieldCoverage: {} };

  const fieldPasses: Record<string, number[]> = {};
  for (const field of requiredFields) {
    fieldPasses[field] = [];
  }

  let totalApplicable = 0;
  let totalPassing = 0;

  for (const gp of goldPages) {
    const matchedPage = pages.find((p) => normalize(p.title) === normalize(gp.title));

    for (const field of gp.requiredFields) {
      totalApplicable++;
      const passes = matchedPage ? matchedPage.frontmatter[field] !== undefined : false;
      if (passes) totalPassing++;
      fieldPasses[field]?.push(passes ? 1 : 0);
    }

    if (gp.expectExecSummary) {
      totalApplicable++;
      const passes = matchedPage?.hasExecSummary ?? false;
      if (passes) totalPassing++;
    }

    if (gp.expectTimeline) {
      totalApplicable++;
      const passes = matchedPage?.hasTimeline ?? false;
      if (passes) totalPassing++;
    }
  }

  const overall = totalApplicable > 0 ? totalPassing / totalApplicable : 1;

  const fieldCoverage: Record<string, number> = {};
  for (const [field, values] of Object.entries(fieldPasses)) {
    if (values.length > 0) {
      fieldCoverage[field] = values.reduce((s, v) => s + v, 0) / values.length;
    }
  }

  return { overall, fieldCoverage };
}
```

- [ ] **Step 2: Export from index**

Add to `packages/bench/src/index.ts`:

```typescript
export {
  matchEntity,
  entityRecall,
  linkMatches,
  backlinkF1,
  schemaCompleteness,
} from "./ingestion-scorer.js";
```

- [ ] **Step 3: Add to tsconfig include**

Add `"src/ingestion-scorer.ts"` to `packages/bench/tsconfig.json` include array.

- [ ] **Step 4: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/ingestion-scorer.ts packages/bench/src/index.ts packages/bench/tsconfig.json
git commit -m "bench: add ingestion scoring utilities

Entity matching (with aliases), entity recall (overall + by-type),
backlink F1 (precision/recall/f1 with bidirectional support),
and schema completeness (frontmatter field coverage)."
```

### Task 7: Create entity recall benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/ingestion-entity-recall/runner.ts`
- Modify: `packages/bench/src/registry.ts`
- Modify: `packages/bench/tsconfig.json`

- [ ] **Step 1: Create the runner**

```typescript
/**
 * Ingestion entity recall benchmark.
 *
 * Feeds a synthetic inbox fixture through the ingestion adapter, then
 * scores extracted entities against the fixture's gold graph.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { IngestionBenchAdapter } from "../../../ingestion-types.js";
import { entityRecall } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionEntityRecallDefinition: BenchmarkDefinition = {
  id: "ingestion-entity-recall",
  title: "Ingestion: Entity Recall",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-entity-recall",
    version: "1.0.0",
    description: "Measures entity extraction recall against a curated gold graph after ingesting synthetic inbox data.",
    category: "ingestion",
  },
};

export async function runIngestionEntityRecallBenchmark(
  options: ResolvedRunBenchmarkOptions & { ingestionAdapter: IngestionBenchAdapter },
): Promise<BenchmarkResult> {
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter.ingest(fixtureDir),
    );

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const { overall, byType } = entityRecall(graph.entities, fixture.goldGraph.entities);

    const scores: Record<string, number> = {
      entity_recall: overall,
      ...byType,
    };

    const tasks = [
      {
        taskId: `entity-recall-${fixture.id}`,
        question: `Extract entities from ${fixture.id} fixture`,
        expected: `${fixture.goldGraph.entities.length} entities`,
        actual: `${graph.entities.length} entities extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldEntityCount: fixture.goldGraph.entities.length,
          extractedEntityCount: graph.entities.length,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Register the benchmark in registry.ts**

Add import at top of `packages/bench/src/registry.ts`:

```typescript
import {
  ingestionEntityRecallDefinition,
  runIngestionEntityRecallBenchmark,
} from "./benchmarks/remnic/ingestion-entity-recall/runner.js";
```

Add to `REGISTERED_BENCHMARKS` array:

```typescript
  {
    ...ingestionEntityRecallDefinition,
    run: runIngestionEntityRecallBenchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
```

- [ ] **Step 3: Add to tsconfig include**

Add `"src/benchmarks/remnic/**/*.ts"` to `packages/bench/tsconfig.json` include array.

- [ ] **Step 4: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/benchmarks/remnic/ingestion-entity-recall/runner.ts packages/bench/src/registry.ts packages/bench/tsconfig.json
git commit -m "bench: add entity recall benchmark for ingestion tier

Scores extracted entities against gold graph with alias-aware matching.
Reports overall recall plus per-type breakdowns (person, org, project, etc.)."
```

---

## PR 4: Backlink F1 Benchmark

### Task 8: Create backlink F1 benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/ingestion-backlink-f1/runner.ts`
- Modify: `packages/bench/src/registry.ts`

- [ ] **Step 1: Create the runner**

```typescript
/**
 * Ingestion backlink F1 benchmark.
 *
 * Scores the extracted bidirectional-link graph against the gold graph.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { IngestionBenchAdapter } from "../../../ingestion-types.js";
import { backlinkF1 } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionBacklinkF1Definition: BenchmarkDefinition = {
  id: "ingestion-backlink-f1",
  title: "Ingestion: Backlink F1",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-backlink-f1",
    version: "1.0.0",
    description: "Measures link extraction quality via precision, recall, and F1 against a curated gold link graph.",
    category: "ingestion",
  },
};

export async function runIngestionBacklinkF1Benchmark(
  options: ResolvedRunBenchmarkOptions & { ingestionAdapter: IngestionBenchAdapter },
): Promise<BenchmarkResult> {
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter.ingest(fixtureDir),
    );

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const { precision, recall, f1 } = backlinkF1(graph.links, fixture.goldGraph.links);

    const scores: Record<string, number> = {
      backlink_precision: precision,
      backlink_recall: recall,
      backlink_f1: f1,
    };

    const tasks = [
      {
        taskId: `backlink-f1-${fixture.id}`,
        question: `Extract links from ${fixture.id} fixture`,
        expected: `${fixture.goldGraph.links.length} links`,
        actual: `${graph.links.length} links extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldLinkCount: fixture.goldGraph.links.length,
          extractedLinkCount: graph.links.length,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Register in registry.ts**

Add import:
```typescript
import {
  ingestionBacklinkF1Definition,
  runIngestionBacklinkF1Benchmark,
} from "./benchmarks/remnic/ingestion-backlink-f1/runner.js";
```

Add to `REGISTERED_BENCHMARKS`:
```typescript
  {
    ...ingestionBacklinkF1Definition,
    run: runIngestionBacklinkF1Benchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
```

- [ ] **Step 3: Verify build**

Run: `cd ~/src/remnic/packages/bench && npm run build`

Expected: clean build

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/benchmarks/remnic/ingestion-backlink-f1/runner.ts packages/bench/src/registry.ts
git commit -m "bench: add backlink F1 benchmark for ingestion tier

Scores extracted link graph against gold graph. Reports precision,
recall, and F1. Supports bidirectional link matching."
```

---

## PR 5: Citation Accuracy Benchmark

### Task 9: Create citation accuracy benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/ingestion-citation-accuracy/runner.ts`
- Modify: `packages/bench/src/registry.ts`

- [ ] **Step 1: Create the runner**

```typescript
/**
 * Ingestion citation accuracy benchmark.
 *
 * Generates a summary from ingested memory, then uses an LLM judge to
 * verify each claim cites a valid source chunk.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { IngestionBenchAdapter, ExtractedPage } from "../../../ingestion-types.js";
import type { BenchJudge } from "../../../adapters/types.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionCitationAccuracyDefinition: BenchmarkDefinition = {
  id: "ingestion-citation-accuracy",
  title: "Ingestion: Citation Accuracy",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-citation-accuracy",
    version: "1.0.0",
    description: "Verifies that claims in generated summaries cite valid source chunks via LLM judge.",
    category: "ingestion",
  },
};

function extractClaims(pages: ExtractedPage[]): Array<{ claim: string; sourcePage: string; sourceContent: string }> {
  const claims: Array<{ claim: string; sourcePage: string; sourceContent: string }> = [];

  for (const page of pages) {
    if (!page.content) continue;
    const sentences = page.content
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);

    for (const sentence of sentences) {
      claims.push({
        claim: sentence,
        sourcePage: page.path,
        sourceContent: page.content,
      });
    }
  }

  return claims;
}

export async function runIngestionCitationAccuracyBenchmark(
  options: ResolvedRunBenchmarkOptions & { ingestionAdapter: IngestionBenchAdapter },
): Promise<BenchmarkResult> {
  const fixture = emailFixture.generate();
  const judge = options.system?.judge;

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter.ingest(fixtureDir),
    );

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const claims = extractClaims(graph.pages);

    let validCitations = 0;
    const totalClaims = claims.length;

    if (judge && totalClaims > 0) {
      for (const { claim, sourceContent } of claims) {
        const score = await judgeCitation(judge, claim, sourceContent, fixture.files.map((f) => f.content).join("\n\n"));
        if (score >= 0.5) validCitations++;
      }
    }

    const citationAccuracy = totalClaims > 0 ? validCitations / totalClaims : 0;

    const scores: Record<string, number> = {
      citation_accuracy: citationAccuracy,
      total_claims: totalClaims,
      valid_citations: validCitations,
    };

    const tasks = [
      {
        taskId: `citation-accuracy-${fixture.id}`,
        question: `Verify citation accuracy for ${fixture.id} fixture`,
        expected: `All claims cite valid sources`,
        actual: `${validCitations}/${totalClaims} claims have valid citations`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          pageCount: graph.pages.length,
          claimCount: totalClaims,
          ingestionErrors: ingestionLog.errors,
          judgeAvailable: !!judge,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function judgeCitation(
  judge: BenchJudge,
  claim: string,
  pageContent: string,
  originalSources: string,
): Promise<number> {
  try {
    return await judge.score(
      `Does the page content support this claim with evidence from the original sources? Claim: "${claim}"`,
      pageContent,
      originalSources,
    );
  } catch {
    return -1;
  }
}
```

- [ ] **Step 2: Register in registry.ts**

Add import:
```typescript
import {
  ingestionCitationAccuracyDefinition,
  runIngestionCitationAccuracyBenchmark,
} from "./benchmarks/remnic/ingestion-citation-accuracy/runner.js";
```

Add to `REGISTERED_BENCHMARKS`:
```typescript
  {
    ...ingestionCitationAccuracyDefinition,
    run: runIngestionCitationAccuracyBenchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/benchmarks/remnic/ingestion-citation-accuracy/runner.ts packages/bench/src/registry.ts
git commit -m "bench: add citation accuracy benchmark for ingestion tier

Uses LLM judge to verify claims in generated pages cite valid
source chunks from the original fixture data."
```

---

## PR 6: Schema Completeness Benchmark

### Task 10: Create schema completeness benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/ingestion-schema-completeness/runner.ts`
- Modify: `packages/bench/src/registry.ts`

- [ ] **Step 1: Create the runner**

```typescript
/**
 * Ingestion schema completeness benchmark.
 *
 * Scores each generated page's frontmatter against the canonical schema.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { IngestionBenchAdapter } from "../../../ingestion-types.js";
import { REQUIRED_FRONTMATTER_FIELDS } from "../../../ingestion-types.js";
import { schemaCompleteness } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionSchemaCompletenessDefinition: BenchmarkDefinition = {
  id: "ingestion-schema-completeness",
  title: "Ingestion: Schema Completeness",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-schema-completeness",
    version: "1.0.0",
    description: "Scores generated pages against the canonical frontmatter schema rubric.",
    category: "ingestion",
  },
};

export async function runIngestionSchemaCompletenessBenchmark(
  options: ResolvedRunBenchmarkOptions & { ingestionAdapter: IngestionBenchAdapter },
): Promise<BenchmarkResult> {
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter.ingest(fixtureDir),
    );

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const { overall, fieldCoverage } = schemaCompleteness(
      graph.pages,
      fixture.goldGraph.pages,
      REQUIRED_FRONTMATTER_FIELDS,
    );

    const scores: Record<string, number> = {
      schema_completeness: overall,
      ...Object.fromEntries(
        Object.entries(fieldCoverage).map(([field, rate]) => [`field_${field.replace(/-/g, "_")}`, rate]),
      ),
    };

    const tasks = [
      {
        taskId: `schema-completeness-${fixture.id}`,
        question: `Check frontmatter schema for ${fixture.id} fixture pages`,
        expected: `All required fields present`,
        actual: `${Math.round(overall * 100)}% schema completeness`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldPageCount: fixture.goldGraph.pages.length,
          extractedPageCount: graph.pages.length,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Register in registry.ts and verify build**

Add import:
```typescript
import {
  ingestionSchemaCompletenessDefinition,
  runIngestionSchemaCompletenessBenchmark,
} from "./benchmarks/remnic/ingestion-schema-completeness/runner.js";
```

Add to `REGISTERED_BENCHMARKS`:
```typescript
  {
    ...ingestionSchemaCompletenessDefinition,
    run: runIngestionSchemaCompletenessBenchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/benchmarks/remnic/ingestion-schema-completeness/runner.ts packages/bench/src/registry.ts
git commit -m "bench: add schema completeness benchmark for ingestion tier

Scores generated page frontmatter against canonical schema: title,
type, state, created, see-also, plus conditional exec-summary and
timeline fields."
```

---

## PR 7: Setup Friction Benchmark

### Task 11: Create setup friction benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/ingestion-setup-friction/runner.ts`
- Modify: `packages/bench/src/registry.ts`

- [ ] **Step 1: Create the runner**

```typescript
/**
 * Ingestion setup friction benchmark.
 *
 * Counts commands and prompts required during ingestion. Lower is better.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { IngestionBenchAdapter } from "../../../ingestion-types.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionSetupFrictionDefinition: BenchmarkDefinition = {
  id: "ingestion-setup-friction",
  title: "Ingestion: Setup Friction",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-setup-friction",
    version: "1.0.0",
    description: "Measures human intervention required during ingestion: commands issued plus prompts shown. Lower is better.",
    category: "ingestion",
  },
};

export async function runIngestionSetupFrictionBenchmark(
  options: ResolvedRunBenchmarkOptions & { ingestionAdapter: IngestionBenchAdapter },
): Promise<BenchmarkResult> {
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter.ingest(fixtureDir),
    );

    const commandsCount = ingestionLog.commandsIssued.length;
    const promptsCount = ingestionLog.promptsShown.length;
    const errorsCount = ingestionLog.errors.length;
    const setupFriction = commandsCount + promptsCount;

    const scores: Record<string, number> = {
      setup_friction: setupFriction,
      commands_count: commandsCount,
      prompts_count: promptsCount,
      errors_count: errorsCount,
    };

    const tasks = [
      {
        taskId: `setup-friction-${fixture.id}`,
        question: `Measure setup friction for ${fixture.id} fixture`,
        expected: `Minimal human intervention`,
        actual: `${setupFriction} interventions (${commandsCount} commands + ${promptsCount} prompts)`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          commands: ingestionLog.commandsIssued,
          prompts: ingestionLog.promptsShown,
          errors: ingestionLog.errors,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Register in registry.ts and verify build**

Add import:
```typescript
import {
  ingestionSetupFrictionDefinition,
  runIngestionSetupFrictionBenchmark,
} from "./benchmarks/remnic/ingestion-setup-friction/runner.js";
```

Add to `REGISTERED_BENCHMARKS`:
```typescript
  {
    ...ingestionSetupFrictionDefinition,
    run: runIngestionSetupFrictionBenchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/benchmarks/remnic/ingestion-setup-friction/runner.ts packages/bench/src/registry.ts
git commit -m "bench: add setup friction benchmark for ingestion tier

Counts commands + prompts during ingestion as a cost metric.
Lower friction = better user experience."
```

---

## PR 8: Remaining Fixtures (Project Folder, Calendar, Chat)

### Task 12: Create project folder fixture

**Files:**
- Create: `packages/bench/src/fixtures/inbox/project-folder.ts`
- Create: `packages/bench/src/fixtures/inbox/project-folder-gold.ts`

- [ ] **Step 1: Create the gold graph**

```typescript
/**
 * Gold graph for the synthetic project folder fixture.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const PROJECT_FOLDER_GOLD_GRAPH: GoldGraph = {
  entities: [
    { id: "proj-atlas", name: "Atlas Platform", type: "project", aliases: ["Atlas"] },
    { id: "p-lin", name: "Lin Zhang", type: "person", aliases: ["Lin"] },
    { id: "p-raj", name: "Raj Patel", type: "person", aliases: ["Raj"] },
    { id: "p-sofia", name: "Sofia Martinez", type: "person", aliases: ["Sofia"] },
    { id: "p-omar", name: "Omar Hassan", type: "person", aliases: ["Omar"] },
    { id: "e-m1", name: "Milestone 1: Core API", type: "event", aliases: ["M1", "Core API milestone"] },
    { id: "e-m2", name: "Milestone 2: Dashboard", type: "event", aliases: ["M2", "Dashboard milestone"] },
    { id: "t-auth", name: "Authentication System", type: "topic", aliases: ["auth", "authentication"] },
    { id: "t-data-pipeline", name: "Data Pipeline", type: "topic", aliases: ["pipeline", "ETL"] },
    { id: "t-monitoring", name: "Monitoring", type: "topic" },
  ],
  links: [
    { source: "p-lin", target: "proj-atlas", relation: "leads", bidirectional: false },
    { source: "p-raj", target: "proj-atlas", relation: "contributes-to", bidirectional: false },
    { source: "p-sofia", target: "proj-atlas", relation: "contributes-to", bidirectional: false },
    { source: "p-omar", target: "proj-atlas", relation: "contributes-to", bidirectional: false },
    { source: "proj-atlas", target: "e-m1", relation: "milestone", bidirectional: false },
    { source: "proj-atlas", target: "e-m2", relation: "milestone", bidirectional: false },
    { source: "p-raj", target: "t-auth", relation: "owns", bidirectional: false },
    { source: "p-sofia", target: "t-data-pipeline", relation: "owns", bidirectional: false },
    { source: "p-omar", target: "t-monitoring", relation: "owns", bidirectional: false },
  ],
  pages: [
    { title: "Atlas Platform", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: true, expectExecSummary: true, expectSeeAlso: ["Lin Zhang", "Milestone 1: Core API"] },
  ],
};
```

- [ ] **Step 2: Create the project folder generator**

```typescript
/**
 * Synthetic project folder fixture generator.
 *
 * Produces a nested directory of markdown, JSON, and text files
 * simulating a real project workspace.
 */

import type { FixtureGenerator, FixtureOutput, GeneratedFile } from "./types.js";
import { PROJECT_FOLDER_GOLD_GRAPH } from "./project-folder-gold.js";

function generateFiles(): GeneratedFile[] {
  return [
    {
      relativePath: "README.md",
      content: `# Atlas Platform

A unified data analytics platform built by the core engineering team.

## Team
- **Lin Zhang** — Project Lead
- **Raj Patel** — Backend (Authentication System)
- **Sofia Martinez** — Data Engineering (Data Pipeline / ETL)
- **Omar Hassan** — Infrastructure (Monitoring)

## Milestones
1. **Milestone 1: Core API** — Due Feb 28, 2026
2. **Milestone 2: Dashboard** — Due Apr 15, 2026

## Architecture
The platform consists of three main subsystems: authentication, data pipeline, and monitoring.
`,
    },
    {
      relativePath: "docs/meeting-notes/2026-01-20-kickoff.md",
      content: `# Kickoff Meeting — Jan 20, 2026

**Attendees:** Lin Zhang, Raj Patel, Sofia Martinez, Omar Hassan

## Decisions
- Raj will own the Authentication System — JWT-based with RBAC
- Sofia takes the Data Pipeline — real-time ETL with Apache Kafka
- Omar handles Monitoring — Prometheus + Grafana stack
- Milestone 1 (Core API) target: Feb 28

## Action Items
- [ ] Raj: Auth service scaffold by Jan 27
- [ ] Sofia: Pipeline POC by Feb 3
- [ ] Omar: Monitoring infra by Feb 10
- [ ] Lin: Weekly status updates starting Jan 27
`,
    },
    {
      relativePath: "docs/meeting-notes/2026-02-10-sprint-review.md",
      content: `# Sprint Review — Feb 10, 2026

**Attendees:** Lin Zhang, Raj Patel, Sofia Martinez

## Updates
- Auth service is feature-complete, pending security review
- Data Pipeline POC running in staging — throughput at 10K events/sec
- Omar was out sick, monitoring work deferred to next sprint

## Risks
- Milestone 1 at risk if monitoring isn't ready by Feb 28
- Lin to discuss with Omar on catch-up plan
`,
    },
    {
      relativePath: "docs/specs/auth-design.md",
      content: `# Authentication System Design

**Author:** Raj Patel
**Status:** Approved

## Overview
JWT-based authentication with role-based access control (RBAC).

## Components
- Token issuer service
- RBAC middleware
- Session store (Redis-backed)

## Endpoints
- POST /auth/login
- POST /auth/refresh
- DELETE /auth/logout
- GET /auth/me
`,
    },
    {
      relativePath: "config/environments.json",
      content: JSON.stringify(
        {
          staging: { host: "staging.atlas.internal", port: 8080 },
          production: { host: "atlas.internal", port: 443 },
        },
        null,
        2,
      ),
    },
    {
      relativePath: "docs/specs/pipeline-design.md",
      content: `# Data Pipeline Design

**Author:** Sofia Martinez
**Status:** Draft

## Overview
Real-time ETL pipeline using Apache Kafka for event ingestion and transformation.

## Flow
1. Producers emit events to Kafka topics
2. Stream processor transforms and enriches
3. Sink connectors write to data warehouse
4. Dashboard queries warehouse via API

## Performance Target
- 10,000 events/second sustained throughput
- < 5 second end-to-end latency
`,
    },
  ];
}

export const projectFolderFixture: FixtureGenerator = {
  id: "project-folder",
  description: "Synthetic project workspace with README, meeting notes, specs, and config",

  generate(): FixtureOutput {
    return {
      id: "project-folder",
      description: this.description,
      files: generateFiles(),
      goldGraph: PROJECT_FOLDER_GOLD_GRAPH,
    };
  },
};
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/fixtures/inbox/project-folder.ts packages/bench/src/fixtures/inbox/project-folder-gold.ts
git commit -m "bench: add project folder fixture generator

Nested directory with README, meeting notes, specs, and config.
4 team members, 2 milestones, 3 technical subsystems."
```

### Task 13: Create calendar fixture

**Files:**
- Create: `packages/bench/src/fixtures/inbox/calendar.ts`
- Create: `packages/bench/src/fixtures/inbox/calendar-gold.ts`

- [ ] **Step 1: Create the gold graph**

```typescript
/**
 * Gold graph for the synthetic calendar fixture.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const CALENDAR_GOLD_GRAPH: GoldGraph = {
  entities: [
    { id: "p-maya", name: "Maya Torres", type: "person", aliases: ["Maya"] },
    { id: "p-ben", name: "Ben Alder", type: "person", aliases: ["Ben"] },
    { id: "p-chen", name: "Wei Chen", type: "person", aliases: ["Wei"] },
    { id: "e-standup", name: "Daily Standup", type: "event", aliases: ["standup"] },
    { id: "e-sprint-planning", name: "Sprint Planning", type: "event" },
    { id: "e-retro", name: "Sprint Retrospective", type: "event", aliases: ["retro"] },
    { id: "e-demo", name: "Client Demo", type: "event", aliases: ["demo day"] },
    { id: "e-offsite", name: "Team Offsite", type: "event", aliases: ["offsite"] },
    { id: "o-client-co", name: "ClientCo", type: "org" },
    { id: "l-hq", name: "Main Office", type: "location", aliases: ["HQ", "Building A"] },
    { id: "l-retreat", name: "Lake House Retreat", type: "location" },
  ],
  links: [
    { source: "p-maya", target: "e-standup", relation: "organizes", bidirectional: false },
    { source: "p-ben", target: "e-standup", relation: "attends", bidirectional: false },
    { source: "p-chen", target: "e-standup", relation: "attends", bidirectional: false },
    { source: "p-maya", target: "e-sprint-planning", relation: "organizes", bidirectional: false },
    { source: "e-demo", target: "o-client-co", relation: "for-client", bidirectional: false },
    { source: "e-standup", target: "l-hq", relation: "at-location", bidirectional: false },
    { source: "e-offsite", target: "l-retreat", relation: "at-location", bidirectional: false },
  ],
  pages: [
    { title: "Maya Torres", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: false, expectExecSummary: false, expectSeeAlso: ["Daily Standup", "Sprint Planning"] },
  ],
};
```

- [ ] **Step 2: Create the calendar generator**

```typescript
/**
 * Synthetic ICS calendar fixture generator.
 *
 * Produces an ICS export with recurring events, one-offs, invitees, and notes.
 */

import type { FixtureGenerator, FixtureOutput, GeneratedFile } from "./types.js";
import { CALENDAR_GOLD_GRAPH } from "./calendar-gold.js";

function generateIcs(): string {
  const events = [
    {
      uid: "standup-001@bench.test",
      summary: "Daily Standup",
      dtstart: "20260201T090000Z",
      dtend: "20260201T091500Z",
      rrule: "FREQ=WEEKLY;COUNT=8;BYDAY=MO,TU,WE,TH,FR",
      location: "Main Office, Building A, Room 301",
      organizer: "Maya Torres <maya.torres@bench.test>",
      attendees: ["Ben Alder <ben.alder@bench.test>", "Wei Chen <wei.chen@bench.test>"],
      description: "Quick sync on blockers and progress. Keep it under 15 minutes.",
    },
    {
      uid: "sprint-plan-001@bench.test",
      summary: "Sprint Planning",
      dtstart: "20260203T140000Z",
      dtend: "20260203T160000Z",
      rrule: "FREQ=WEEKLY;COUNT=4;INTERVAL=2;BYDAY=TU",
      location: "Main Office, Building A, Room 500",
      organizer: "Maya Torres <maya.torres@bench.test>",
      attendees: ["Ben Alder <ben.alder@bench.test>", "Wei Chen <wei.chen@bench.test>"],
      description: "Bi-weekly sprint planning. Review backlog, assign stories, estimate.",
    },
    {
      uid: "retro-001@bench.test",
      summary: "Sprint Retrospective",
      dtstart: "20260214T150000Z",
      dtend: "20260214T160000Z",
      location: "Main Office, Building A, Room 500",
      organizer: "Maya Torres <maya.torres@bench.test>",
      attendees: ["Ben Alder <ben.alder@bench.test>", "Wei Chen <wei.chen@bench.test>"],
      description: "What went well, what didn't, what to change. Bring snacks.",
    },
    {
      uid: "demo-001@bench.test",
      summary: "Client Demo",
      dtstart: "20260220T100000Z",
      dtend: "20260220T113000Z",
      location: "Main Office, Building A, Executive Suite",
      organizer: "Maya Torres <maya.torres@bench.test>",
      attendees: ["Ben Alder <ben.alder@bench.test>", "Wei Chen <wei.chen@bench.test>", "ClientCo Team <team@clientco.test>"],
      description: "Demo day for ClientCo. Show the dashboard and API integration. Ben presents backend, Wei presents frontend.",
    },
    {
      uid: "offsite-001@bench.test",
      summary: "Team Offsite",
      dtstart: "20260315T090000Z",
      dtend: "20260316T170000Z",
      location: "Lake House Retreat, 123 Lakeside Dr",
      organizer: "Maya Torres <maya.torres@bench.test>",
      attendees: ["Ben Alder <ben.alder@bench.test>", "Wei Chen <wei.chen@bench.test>"],
      description: "Two-day team offsite. Day 1: strategy and roadmap. Day 2: team building and hackathon.",
    },
  ];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bench//Synthetic//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`SUMMARY:${ev.summary}`);
    lines.push(`DTSTART:${ev.dtstart}`);
    lines.push(`DTEND:${ev.dtend}`);
    if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
    if (ev.location) lines.push(`LOCATION:${ev.location}`);
    lines.push(`ORGANIZER;CN=${ev.organizer}`);
    for (const att of ev.attendees) {
      lines.push(`ATTENDEE;CN=${att}`);
    }
    if (ev.description) lines.push(`DESCRIPTION:${ev.description}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export const calendarFixture: FixtureGenerator = {
  id: "calendar",
  description: "Synthetic ICS calendar with recurring standups, sprint events, client demo, and team offsite",

  generate(): FixtureOutput {
    return {
      id: "calendar",
      description: this.description,
      files: [{ relativePath: "calendar.ics", content: generateIcs() }],
      goldGraph: CALENDAR_GOLD_GRAPH,
    };
  },
};
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/fixtures/inbox/calendar.ts packages/bench/src/fixtures/inbox/calendar-gold.ts
git commit -m "bench: add calendar fixture generator

ICS export with recurring standups, sprint ceremonies, client demo,
and team offsite. 3 people, 5 event types, 2 locations."
```

### Task 14: Create chat fixture

**Files:**
- Create: `packages/bench/src/fixtures/inbox/chat.ts`
- Create: `packages/bench/src/fixtures/inbox/chat-gold.ts`

- [ ] **Step 1: Create the gold graph**

```typescript
/**
 * Gold graph for the synthetic chat transcript fixture.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const CHAT_GOLD_GRAPH: GoldGraph = {
  entities: [
    { id: "p-alex", name: "Alex Rivera", type: "person", aliases: ["Alex", "arivera"] },
    { id: "p-sam", name: "Sam Okonkwo", type: "person", aliases: ["Sam", "sokonkwo"] },
    { id: "p-jo", name: "Jo Park", type: "person", aliases: ["Jo", "jpark"] },
    { id: "p-lee", name: "Lee Andersen", type: "person", aliases: ["Lee", "landersen"] },
    { id: "t-general", name: "#general", type: "topic" },
    { id: "t-eng", name: "#engineering", type: "topic" },
    { id: "t-releases", name: "#releases", type: "topic" },
    { id: "proj-v2", name: "v2 Migration", type: "project", aliases: ["v2", "the migration"] },
    { id: "t-ci", name: "CI Pipeline", type: "topic", aliases: ["CI", "pipeline"] },
  ],
  links: [
    { source: "p-alex", target: "proj-v2", relation: "leads", bidirectional: false },
    { source: "p-sam", target: "proj-v2", relation: "contributes-to", bidirectional: false },
    { source: "p-jo", target: "t-ci", relation: "owns", bidirectional: false },
    { source: "p-alex", target: "p-sam", relation: "collaborates-with", bidirectional: true },
    { source: "proj-v2", target: "t-ci", relation: "depends-on", bidirectional: false },
  ],
  pages: [
    { title: "v2 Migration", requiredFields: ["title", "type", "state", "created", "see-also"], expectTimeline: true, expectExecSummary: true, expectSeeAlso: ["Alex Rivera", "Sam Okonkwo"] },
  ],
};
```

- [ ] **Step 2: Create the chat generator**

```typescript
/**
 * Synthetic chat transcript fixture generator.
 *
 * Produces a JSON transcript simulating Slack-style channels, DMs,
 * threads, and reactions.
 */

import type { FixtureGenerator, FixtureOutput, GeneratedFile } from "./types.js";
import { CHAT_GOLD_GRAPH } from "./chat-gold.js";

interface ChatMessage {
  id: string;
  channel: string;
  user: string;
  text: string;
  timestamp: string;
  threadId?: string;
  reactions?: Array<{ emoji: string; users: string[] }>;
}

interface ChatTranscript {
  channels: Array<{ id: string; name: string; topic: string }>;
  messages: ChatMessage[];
}

function generateTranscript(): ChatTranscript {
  return {
    channels: [
      { id: "ch-general", name: "general", topic: "Company-wide announcements" },
      { id: "ch-eng", name: "engineering", topic: "Engineering discussions" },
      { id: "ch-releases", name: "releases", topic: "Release coordination" },
    ],
    messages: [
      {
        id: "msg-001",
        channel: "ch-eng",
        user: "arivera",
        text: "Heads up: I'm starting the v2 Migration this week. Sam, you're on the database schema changes. I'll handle the API layer.",
        timestamp: "2026-02-01T09:15:00Z",
      },
      {
        id: "msg-002",
        channel: "ch-eng",
        user: "sokonkwo",
        text: "Got it. I'll branch off main and start with the users table migration. Should have a PR up by Wednesday.",
        timestamp: "2026-02-01T09:18:00Z",
        threadId: "msg-001",
      },
      {
        id: "msg-003",
        channel: "ch-eng",
        user: "jpark",
        text: "FYI the CI Pipeline might need updates for the new schema. I'll review once Sam's PR is up.",
        timestamp: "2026-02-01T09:22:00Z",
        threadId: "msg-001",
        reactions: [{ emoji: "thumbsup", users: ["arivera", "sokonkwo"] }],
      },
      {
        id: "msg-004",
        channel: "ch-general",
        user: "landersen",
        text: "Reminder: all-hands meeting Thursday at 2pm. Alex will present the v2 Migration roadmap.",
        timestamp: "2026-02-02T10:00:00Z",
        reactions: [{ emoji: "calendar", users: ["arivera", "sokonkwo", "jpark"] }],
      },
      {
        id: "msg-005",
        channel: "ch-eng",
        user: "sokonkwo",
        text: "PR is up for the users table migration: PR #142. Alex, can you review?",
        timestamp: "2026-02-03T14:30:00Z",
      },
      {
        id: "msg-006",
        channel: "ch-eng",
        user: "arivera",
        text: "Reviewing now. Looks solid so far. One question: should we add a rollback script?",
        timestamp: "2026-02-03T15:00:00Z",
        threadId: "msg-005",
      },
      {
        id: "msg-007",
        channel: "ch-eng",
        user: "sokonkwo",
        text: "Good call. I'll add a rollback migration in the same PR.",
        timestamp: "2026-02-03T15:10:00Z",
        threadId: "msg-005",
        reactions: [{ emoji: "ok_hand", users: ["arivera"] }],
      },
      {
        id: "msg-008",
        channel: "ch-eng",
        user: "jpark",
        text: "CI Pipeline is updated for the new schema. Tests are green. Merging the CI changes now.",
        timestamp: "2026-02-04T11:00:00Z",
        reactions: [{ emoji: "rocket", users: ["arivera", "sokonkwo", "landersen"] }],
      },
      {
        id: "msg-009",
        channel: "ch-releases",
        user: "arivera",
        text: "v2 Migration Phase 1 is code-complete. Sam's schema changes merged, Jo's CI updates are in. Targeting staging deploy Monday.",
        timestamp: "2026-02-06T16:00:00Z",
      },
      {
        id: "msg-010",
        channel: "ch-releases",
        user: "landersen",
        text: "Nice work team. I'll prepare the stakeholder update email over the weekend.",
        timestamp: "2026-02-06T16:15:00Z",
        threadId: "msg-009",
      },
      // DM thread
      {
        id: "msg-011",
        channel: "dm-alex-sam",
        user: "arivera",
        text: "Hey Sam, quick question — did you test the migration against a copy of prod data? Want to make sure we don't hit any edge cases.",
        timestamp: "2026-02-05T08:00:00Z",
      },
      {
        id: "msg-012",
        channel: "dm-alex-sam",
        user: "sokonkwo",
        text: "Yeah, ran it against last night's snapshot. Two edge cases with null email fields — I added a data fix in the migration. All clean now.",
        timestamp: "2026-02-05T08:15:00Z",
        threadId: "msg-011",
      },
    ],
  };
}

export const chatFixture: FixtureGenerator = {
  id: "chat",
  description: "Synthetic Slack-style chat transcript with 3 channels, 1 DM thread, threads, and reactions",

  generate(): FixtureOutput {
    const transcript = generateTranscript();
    const content = JSON.stringify(transcript, null, 2);

    return {
      id: "chat",
      description: this.description,
      files: [{ relativePath: "chat-export.json", content }],
      goldGraph: CHAT_GOLD_GRAPH,
    };
  },
};
```

- [ ] **Step 3: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/fixtures/inbox/chat.ts packages/bench/src/fixtures/inbox/chat-gold.ts
git commit -m "bench: add chat transcript fixture generator

Slack-style JSON transcript with 3 channels, 1 DM thread,
12 messages, threads, and reactions. 4 participants, 1 project."
```

### Task 15: Export all fixtures from index

**Files:**
- Modify: `packages/bench/src/index.ts`

- [ ] **Step 1: Add fixture exports**

Add to `packages/bench/src/index.ts`:

```typescript
export { emailFixture } from "./fixtures/inbox/email.js";
export { projectFolderFixture } from "./fixtures/inbox/project-folder.js";
export { calendarFixture } from "./fixtures/inbox/calendar.js";
export { chatFixture } from "./fixtures/inbox/chat.js";
```

- [ ] **Step 2: Verify build and commit**

```bash
cd ~/src/remnic/packages/bench && npm run build
git add packages/bench/src/index.ts
git commit -m "bench: export all inbox fixtures from package index"
```
