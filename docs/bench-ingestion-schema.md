# Ingestion benchmark: canonical page frontmatter schema

This document defines the frontmatter schema that the **schema-completeness** rubric scores
against during ingestion benchmarks. Every generated memory page is evaluated field by field;
the aggregate score is `passing_field_checks / total_applicable_checks`.

## Required fields

All generated pages must include the following YAML frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable page title. Must be non-empty. |
| `type` | string | Memory page type. Common values: `person`, `org`, `project`, `topic`, `event`, `location`. |
| `state` | string | Lifecycle state. Common values: `active`, `archived`, `superseded`. |
| `created` | ISO 8601 date string | Date the page was first created (e.g. `2026-01-15`). |
| `see-also` | list of strings | Cross-references to related pages by title or path. Must be an array (empty array `[]` is acceptable when no related pages exist). |

A page that omits any of these fields contributes a failing check for that field toward the
completeness score.

## Conditional fields

These fields are required only for certain entity types. The benchmark gold graph records
`expectExecSummary` and `expectTimeline` per gold page; the rubric only scores them when the
flag is set.

### `exec-summary`

**Required when** the page represents a `project`, `org`, or `event` entity.

A prose block that summarises the entity's purpose, status, and key facts in three to five
sentences. It must appear either as a frontmatter key or as a dedicated heading section
(`## Executive Summary` / `## Exec Summary`) in the body.

The scorer treats the field as present if `ExtractedPage.hasExecSummary` is `true`.

### `timeline`

**Required when** the page represents a `project` or `event` entity.

An ordered list of milestones or dated entries. It must appear as a frontmatter key or as a
dedicated heading section (`## Timeline`) in the body.

The scorer treats the field as present if `ExtractedPage.hasTimeline` is `true`.

## Scoring details

The scorer is implemented in `packages/bench/src/ingestion-scorer.ts` under `schemaCompleteness`.

For each gold page:

1. Every field in `goldPage.requiredFields` is checked. A check passes if the corresponding
   key exists in `extractedPage.frontmatter` (value may be any non-`undefined` value).
2. If `goldPage.expectExecSummary` is `true`, `extractedPage.hasExecSummary` must be `true`.
3. If `goldPage.expectTimeline` is `true`, `extractedPage.hasTimeline` must be `true`.
4. Each entry in `goldPage.expectSeeAlso` is checked individually; a check passes if the
   extracted page's `seeAlso` list contains a matching entry after Unicode NFKC normalization
   and lowercasing.

If no gold pages are defined for a fixture, `schemaCompleteness` returns `1.0` (full score).

The primary metric for the `ingestion-schema-completeness` benchmark is `schema_completeness`,
which is the `overall` value from `schemaCompleteness`.

## Example

A conforming page for a project entity looks like this:

```markdown
---
title: Example Project Alpha
type: project
state: active
created: 2026-01-10
see-also:
  - Team Gamma
  - Q1 Roadmap
exec-summary: >
  Example Project Alpha is a synthetic demo project used in ingestion fixtures.
  It is currently active and involves Team Gamma. Key deliverables land in Q2 2026.
timeline:
  - 2026-01-10: Project kicked off
  - 2026-03-01: Milestone 1 complete
---

Body content follows...
```

A page that is missing `state`, `created`, and `see-also` would receive 2 passing checks out of
5 required (`title` and `type` present), yielding a field-coverage fraction of 0.40 for that page.

## Related

- `packages/bench/src/ingestion-types.ts` — `REQUIRED_FRONTMATTER_FIELDS`, `CONDITIONAL_FRONTMATTER`, `GoldPage`
- `packages/bench/src/ingestion-scorer.ts` — `schemaCompleteness` implementation
- `packages/bench/src/benchmarks/remnic/ingestion-schema-completeness/` — benchmark runner
- `packages/bench-ui/src/pages/Ingestion.tsx` — dashboard view for all five ingestion metrics
