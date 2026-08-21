# External Enrichment Pipeline

Issue #365 — Importance-tiered API spend for entity enrichment.

## Overview

The enrichment pipeline enables Remnic to enrich entity pages with
information from external sources (web search, APIs, knowledge bases)
while controlling cost through importance-based provider tiering.

The pipeline is **opt-in and disabled by default**. When enabled, it
evaluates each entity's importance level and selects which providers to
run based on configurable thresholds. Critical entities may justify
expensive API calls; low-importance entities skip enrichment entirely.

## Architecture

```
Entity page
  |
  v
Importance level  ->  Provider selection  ->  Provider execution
  |                                               |
  v                                               v
  "critical" -> [web-search, gpt-enricher]   Candidates[]
  "high"     -> [web-search]                     |
  "normal"   -> [web-search]                     v
  "low"      -> []                          Cap & tag
  "trivial"  -> [] (always empty)                |
                                                 v
                                           EnrichmentResult
                                           + Audit trail
```

### Key components

| Module | Purpose |
|--------|---------|
| `enrichment/types.ts` | Interfaces for providers, candidates, config |
| `enrichment/provider-registry.ts` | Central registry; resolves providers for importance tiers |
| `enrichment/pipeline.ts` | Orchestrator: iterates entities, runs providers, rate-limits |
| `enrichment/web-search-provider.ts` | Stub provider backed by an injected search function |
| `enrichment/audit.ts` | Append-only JSONL audit log |

## Configuration

Add these to your Remnic config:

```json
{
  "enrichmentEnabled": false,
  "enrichmentAutoOnCreate": false,
  "enrichmentMaxCandidatesPerEntity": 20
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enrichmentEnabled` | boolean | `false` | Enable the enrichment pipeline |
| `enrichmentAutoOnCreate` | boolean | `false` | Auto-enrich new entities on creation |
| `enrichmentMaxCandidatesPerEntity` | integer | `20` | Max candidates accepted per entity per run |

### Pipeline config (programmatic)

When building a pipeline programmatically, use `defaultEnrichmentPipelineConfig()`
and override fields as needed:

```ts
import {
  defaultEnrichmentPipelineConfig,
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
} from "@remnic/core";

const config = defaultEnrichmentPipelineConfig();
config.enabled = true;
config.importanceThresholds.critical = ["web-search"];
config.providers = [{ id: "web-search", enabled: true, costTier: "cheap" }];

const registry = new EnrichmentProviderRegistry();
registry.register(new WebSearchProvider({ searchFn: mySearchFn }));

const results = await runEnrichmentPipeline(entities, registry, config, logger);
```

## Writing a Custom Provider

Implement the `EnrichmentProvider` interface:

```ts
import type {
  EnrichmentProvider,
  EnrichmentCandidate,
  EntityEnrichmentInput,
  EnrichmentCostTier,
} from "@remnic/core";

export class MyProvider implements EnrichmentProvider {
  readonly id = "my-provider";
  readonly costTier: EnrichmentCostTier = "expensive";

  async isAvailable(): Promise<boolean> {
    // Check if API key is configured, service is reachable, etc.
    return true;
  }

  async enrich(entity: EntityEnrichmentInput): Promise<EnrichmentCandidate[]> {
    // Call your API, parse results, return candidates
    return [
      {
        text: "Discovered fact about " + entity.name,
        source: this.id,
        sourceUrl: "https://api.example.com/...",
        confidence: 0.85,
        category: "fact",
        tags: ["external", "my-provider"],
      },
    ];
  }
}
```

Then register it:

```ts
registry.register(new MyProvider());
```

And add it to the pipeline config providers list and importance thresholds.

## Audit Trail

Every enrichment candidate evaluation is recorded in an append-only
JSONL file at `<memoryDir>/enrichment/enrichment-audit.jsonl`.

Each line is a JSON object:

```json
{
  "timestamp": "2026-04-16T10:00:00.000Z",
  "entityName": "Acme Corp",
  "provider": "web-search",
  "candidateText": "Acme Corp founded in 2015",
  "sourceUrl": "https://example.com",
  "accepted": true,
  "reason": null
}
```

Read the audit log programmatically:

```ts
import { readAuditLog } from "@remnic/core";

const entries = await readAuditLog(auditDir);
const recent = await readAuditLog(auditDir, "2026-04-16T00:00:00Z");
```

## CLI Commands

```
remnic enrich <entity-name>    # Manually enrich a specific entity
remnic enrich --all            # Enrich all entities
remnic enrich --dry-run        # Preview what would be enriched
remnic enrich audit            # Show recent enrichment audit log
remnic enrich providers        # List registered providers and their status
```

## Rate Limiting

Each provider config can specify rate limits:

```json
{
  "id": "web-search",
  "enabled": true,
  "costTier": "cheap",
  "rateLimit": { "maxPerMinute": 10, "maxPerDay": 500 }
}
```

The pipeline tracks per-provider call counts per minute and per day.
When a limit is reached, subsequent calls for that provider are skipped
(not queued) and the result records zero candidates found.
