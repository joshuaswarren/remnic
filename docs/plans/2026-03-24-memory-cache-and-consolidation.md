# Memory Cache, Semantic Consolidation & Archive Cache

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Speed up recall by 10x through smart caching of `readAllMemories()`, reduce memory bloat through semantic consolidation, and add archive cache for cold recall.

**Architecture:** Add a process-level singleton cache to `StorageManager` keyed by `memoryStatusVersion` (already bumped on every write/archive/delete). Add a semantic consolidation engine that groups similar memories by token overlap, synthesizes canonical versions via LLM, and archives originals. Archive cache follows the same pattern as the hot cache.

**Tech Stack:** TypeScript, node:fs, existing `StorageManager`, `FallbackLlmClient`, `CompoundingEngine` patterns, existing CLI registration via `registerCli`.

---

## Task 1: Smart Memory Cache in StorageManager

**Files:**
- Create: `src/memory-cache.ts`
- Modify: `src/storage.ts` (readAllMemories, readArchivedMemories, writeMemory, archiveMemory)
- Test: `tests/memory-cache.test.ts`

### Design

Static module-level cache shared across all `StorageManager` instances:

```typescript
// src/memory-cache.ts
interface CacheEntry {
  memories: Map<string, MemoryFile>;  // keyed by memoryId
  version: number;                     // memoryStatusVersion at load time
  loadedAt: number;                    // Date.now() at load time
}

// Keyed by baseDir so multi-namespace setups each get their own cache
const cacheByDir = new Map<string, CacheEntry>();
```

**Invalidation:** Compare `getMemoryStatusVersion()` (already bumped on every write/archive/delete) against `cache.version`. If they differ, do an incremental refresh.

**Incremental refresh:** Walk `facts/` and `corrections/` subdirectories. For each date dir, compare mtime. Only re-read dirs whose mtime changed. Remove entries for deleted files.

**Write-through:** `writeMemory()`, `archiveMemory()`, `deleteMemory()` update the cache inline after disk write succeeds.

### Implementation

1. Create `src/memory-cache.ts` with `MemoryCache` class
2. Add `getFromCache()` and `updateCache()` to `StorageManager`
3. Modify `readAllMemories()` to check cache first
4. Modify `readArchivedMemories()` with same pattern
5. Ensure `writeMemory()`, `archiveMemory()` update cache inline
6. Tests: cold cache, warm cache hit, invalidation on write, cross-instance sharing

## Task 2: Config Schema for Consolidation

**Files:**
- Modify: `openclaw.plugin.json` (add config keys)
- Modify: `src/config.ts` (parse new keys)

### New config keys

```json
{
  "semanticConsolidationEnabled": { "type": "boolean", "default": false },
  "semanticConsolidationModel": { "type": "string", "default": "auto", "description": "LLM model: 'auto' (uses primary), 'fast' (uses fast local), or a specific model name" },
  "semanticConsolidationThreshold": { "type": "number", "default": 0.8, "description": "Token overlap threshold (0-1). 0.8=conservative, 0.6=aggressive" },
  "semanticConsolidationMinClusterSize": { "type": "number", "default": 3, "description": "Min similar memories before consolidation triggers" },
  "semanticConsolidationExcludeCategories": { "type": "array", "items": { "type": "string" }, "default": ["correction", "commitment"] },
  "semanticConsolidationIntervalHours": { "type": "number", "default": 168, "description": "Hours between auto-consolidation runs (168=weekly)" },
  "semanticConsolidationMaxPerRun": { "type": "number", "default": 100, "description": "Max memories to consolidate per run to limit LLM cost" }
}
```

## Task 3: Semantic Consolidation Engine

**Files:**
- Create: `src/semantic-consolidation.ts`
- Modify: `src/orchestrator.ts` (wire in scheduled run + runSemanticConsolidationNow)
- Modify: `src/cli.ts` (add CLI command)
- Test: `tests/semantic-consolidation.test.ts`

### Design

1. **Group phase:** Load all active memories (from cache — fast now). Group by category. Within each category, compute pairwise token overlap scores. Build clusters of memories above threshold.
2. **Synthesis phase:** For each cluster ≥ minClusterSize, send to LLM: "These N memories say similar things. Synthesize one canonical memory that preserves all unique information."
3. **Archive phase:** Write the canonical memory. Archive originals with `reasonCode: "semantic-consolidation"` and `relatedMemoryIds` pointing to canonical.
4. **Scheduling:** Run on `semanticConsolidationIntervalHours` interval, triggered from maintenance pass. Also available as `openclaw engram semantic-consolidate [--dry-run] [--verbose] [--threshold N]`.

### Consolidation excluded categories
- `correction` — behavioral guidance, always preserved verbatim
- `commitment` — tracks specific promises with deadlines

## Task 4: Archive Cache Layer

**Files:**
- Modify: `src/memory-cache.ts` (add archive cache alongside hot cache)
- Modify: `src/storage.ts` (readArchivedMemories uses cache)

Same pattern as hot cache but separate `CacheEntry`. Archive changes rarely, so cache lifetime is longer. Uses a separate version counter (archive directory mtime).

---

## Implementation Order

1. Memory cache (Task 1) — immediate perf win
2. Config schema (Task 2) — needed before consolidation
3. Semantic consolidation (Task 3) — reduces file count
4. Archive cache (Task 4) — same pattern, quick to add after Task 1
