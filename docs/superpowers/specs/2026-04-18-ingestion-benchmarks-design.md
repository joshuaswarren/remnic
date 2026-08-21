# Ingestion Benchmark Tier Design

**Issue:** #449
**Date:** 2026-04-18
**Status:** Approved

## Problem

The bench suite measures retrieval (did the brain find what's already filed?) but not ingestion (can the brain turn raw input into a well-structured memory graph?). This is the axis that most differentiates a personal-brain tool from a generic RAG pipeline.

## Architecture

### New Adapter: `IngestionBenchAdapter`

Separate from `BenchMemoryAdapter` (which handles store/recall for retrieval benchmarks). Ingestion follows a different flow: feed raw content, then inspect the resulting memory graph.

```typescript
interface IngestionLog {
  commandsIssued: string[];
  promptsShown: string[];
  errors: string[];
  durationMs: number;
}

interface MemoryGraph {
  entities: ExtractedEntity[];
  links: ExtractedLink[];
  pages: ExtractedPage[];
}

interface ExtractedEntity {
  name: string;
  type: string;
  sourceFile: string;
}

interface ExtractedLink {
  source: string;
  target: string;
  relation: string;
}

interface ExtractedPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  hasExecSummary: boolean;
  hasTimeline: boolean;
  seeAlso: string[];
  content: string;
}

interface IngestionBenchAdapter {
  ingest(inputDir: string): Promise<IngestionLog>;
  getMemoryGraph(): Promise<MemoryGraph>;
  reset(): Promise<void>;
  destroy(): Promise<void>;
}
```

### Gold Graph Schema

Every fixture ships a `GoldGraph` that benchmarks score against:

```typescript
interface GoldEntity {
  id: string;
  name: string;
  type: "person" | "org" | "project" | "topic" | "event" | "location";
  aliases?: string[];
}

interface GoldLink {
  source: string;  // GoldEntity.id
  target: string;  // GoldEntity.id
  relation: string;
  bidirectional: boolean;
}

interface GoldPage {
  title: string;
  requiredFields: string[];
  expectTimeline: boolean;
  expectExecSummary: boolean;
  expectSeeAlso: string[];
}

interface GoldGraph {
  entities: GoldEntity[];
  links: GoldLink[];
  pages: GoldPage[];
}
```

### Frontmatter Schema (for completeness rubric)

The canonical frontmatter schema scored against, based on `~/git/brain` patterns:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `title` | yes | string | Page title |
| `type` | yes | enum | person, org, project, topic, event, location |
| `state` | yes | enum | active, archived, dormant |
| `created` | yes | ISO date | Creation timestamp |
| `see-also` | yes | string[] | Bidirectional links to related pages |
| `exec-summary` | conditional | string | Required for project/org/event pages |
| `timeline` | conditional | entry[] | Required for project/event pages |

### Category Extension

Add `"ingestion"` to `BenchmarkCategory` type union in `types.ts`.

## Fixtures

All synthetic, no PII. Generators under `packages/bench/src/fixtures/inbox/`.

### Email (`email.ts` + `email-gold.ts`)
- Mbox-style output: ~20 messages across 5 threads
- 8 synthetic people, 3 orgs, 2 projects
- Includes forwards, quoted text, thread references
- Gold: entities for all people/orgs/projects, links for collaborations, reply-chains

### Project Folder (`project-folder.ts` + `project-folder-gold.ts`)
- Nested directory: README, meeting notes (markdown), spec docs, config files (JSON)
- 1 project with 4 team members, 2 milestones, 3 deliverables
- Gold: project entity, person entities, milestone events, deliverable topics

### Calendar (`calendar.ts` + `calendar-gold.ts`)
- ICS export: ~15 events over 2 months
- Recurring standup, one-off meetings with invitees, notes
- Gold: event entities, person entities (invitees), project links

### Chat (`chat.ts` + `chat-gold.ts`)
- JSON transcript: ~50 messages across 3 channels + 1 DM thread
- Slack-style with threads, reactions, channel topics
- Gold: person entities (participants), topic entities (channels), project references

## Metrics (5 benchmarks)

### 1. Entity Recall (`ingestion-entity-recall`)
- **Formula:** `|extracted ∩ gold| / |gold|`
- **Matching:** Normalize text, check aliases. Entity type must also match.
- **Output scores:** `entity_recall` (overall), plus per-type breakdowns (`person_recall`, `org_recall`, etc.)

### 2. Backlink F1 (`ingestion-backlink-f1`)
- **Precision:** correct links / extracted links
- **Recall:** correct links / gold links
- **F1:** harmonic mean of precision and recall
- **Link matching:** source+target+relation must match. For `bidirectional: true` links, either direction counts.
- **Output scores:** `backlink_precision`, `backlink_recall`, `backlink_f1`

### 3. Citation Accuracy (`ingestion-citation-accuracy`)
- **Flow:** Generate a summary from ingested memory, then use LLM judge to verify each claim cites a valid source chunk.
- **Formula:** `claims_with_valid_citation / total_claims`
- **Judge prompt:** For each claim, verify the cited source contains supporting evidence.
- **Output scores:** `citation_accuracy`, `total_claims`, `valid_citations`

### 4. Schema Completeness (`ingestion-schema-completeness`)
- **Flow:** Inspect each generated page's frontmatter against the canonical schema.
- **Scoring:** Pass/fail per required field. Conditional fields (exec-summary, timeline) scored only when applicable.
- **Formula:** `passing_fields / total_applicable_fields` per page, aggregated across all pages.
- **Output scores:** `schema_completeness` (overall), `field_coverage` (per-field pass rates)

### 5. Setup Friction (`ingestion-setup-friction`)
- **Flow:** Count entries in `IngestionLog` — commands issued and prompts requiring human input.
- **Formula:** `commands_issued + prompts_shown`. Lower is better.
- **Output scores:** `setup_friction` (total), `commands_count`, `prompts_count`, `errors_count`
- **Note:** Unlike other metrics, this is a cost metric (lower = better), not a quality metric (higher = better).

## PR Slicing Strategy

Vertical slices — each PR is independently shippable and testable.

| PR | Title | Contents | Depends On |
|----|-------|----------|------------|
| 1 | `bench: add ingestion types and adapter interface` | `GoldGraph`, `IngestionBenchAdapter`, `IngestionLog`, `MemoryGraph` types; add `"ingestion"` to `BenchmarkCategory`; frontmatter schema constants | — |
| 2 | `bench: add email fixture generator` | `fixtures/inbox/email.ts` + `email-gold.ts`; `FixtureOutput` type | PR 1 |
| 3 | `bench: add entity recall benchmark` | `benchmarks/remnic/ingestion-entity-recall/runner.ts`; registry entry; entity matching utils | PR 1, 2 |
| 4 | `bench: add backlink F1 benchmark` | `benchmarks/remnic/ingestion-backlink-f1/runner.ts`; registry entry; link matching utils | PR 1, 2 |
| 5 | `bench: add citation accuracy benchmark` | `benchmarks/remnic/ingestion-citation-accuracy/runner.ts`; registry entry; judge integration | PR 1, 2 |
| 6 | `bench: add schema completeness benchmark` | `benchmarks/remnic/ingestion-schema-completeness/runner.ts`; registry entry; frontmatter checker | PR 1, 2 |
| 7 | `bench: add setup friction benchmark` | `benchmarks/remnic/ingestion-setup-friction/runner.ts`; registry entry | PR 1 |
| 8 | `bench: add project-folder, calendar, chat fixtures` | remaining 3 fixture generators + gold graphs; wire into existing benchmarks | PR 1 |

## Out of Scope

- Dashboard UI for ingestion metrics
- Retrieval-side metrics on ingested corpus (separate issue)
- Assistant-style synthesis over ingested data (separate issue)
- Real PII or external datasets
