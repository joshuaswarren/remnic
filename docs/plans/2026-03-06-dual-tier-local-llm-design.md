# Dual-Tier Local LLM Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route fast local LLM operations (rerank, entity_summary, tmt_summary, compression_guideline) to a smaller/faster model while keeping heavy operations (extraction, consolidation, summarization) on the smart model.

**Architecture:** Create a second `LocalLlmClient` instance (`fastLlm`) configured with a smaller model. Operations declare which tier they need. When fast tier is disabled or unconfigured, everything falls back to the primary model — zero behavior change for existing users.

**Tech Stack:** TypeScript, same `LocalLlmClient` class (no changes), LM Studio serving two models on one port.

## Operation Routing

| Tier | Operations | Rationale |
|------|-----------|-----------|
| **Fast** | `rerank`, `entity_summary`, `tmt_summary`, `compression_guideline_semantic_refinement` | Short prompts, tight timeouts, quality floor is low |
| **Smart** | `extraction`, `consolidation`, `profile_consolidation`, `identity_consolidation`, `hourly_summary`, `hourly_summary_extended` | Complex reasoning, structured JSON, quality matters |

## Config Keys (4 new)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `localLlmFastModel` | string | `""` | Model ID for fast operations (empty = use primary) |
| `localLlmFastUrl` | string | same as `localLlmUrl` | Endpoint for fast model |
| `localLlmFastTimeoutMs` | number | `15000` | Timeout for fast model requests |
| `localLlmFastEnabled` | boolean | `false` | Opt-in toggle |

## Files Changed

- `src/types.ts` — 4 new config keys
- `src/config.ts` — defaults for 4 keys
- `openclaw.plugin.json` — 4 schema properties
- `src/orchestrator.ts` — create `fastLlm` instance, route fast ops to it
- No changes to `local-llm.ts`, `extraction.ts`, or `summarizer.ts`
