# Inductive rule consolidation (IRC)

IRC is a preference synthesis layer in Remnic's recall pipeline. It detects preference signals in stored conversations and synthesizes explicit preference statements that are injected into recall context.

## Problem

Remnic stores conversations as factual content: *"I enjoy Adobe Premiere Pro for video editing."* But when a user later asks *"Can you recommend video editing resources?"*, the recall context needs to clearly signal that this user prefers Adobe Premiere Pro. Without IRC, the raw text is returned but preference intent isn't surfaced explicitly.

## How it works

IRC runs as a parallel recall section in the orchestrator, using a dual-strategy approach:

### Strategy 1: Extracted Memory Files (Production)

When LLM-powered extraction is available, Remnic extracts structured facts, entities, and preferences from conversations. IRC reads these extracted memories and consolidates them into preference statements using pattern matching and the `consolidatePreferences()` function.

### Strategy 2: LCM FTS Fallback (No LLM)

When extraction hasn't run (no LLM available, e.g., during benchmarks or offline use), IRC falls back to regex-based synthesis from raw conversation text stored in LCM's SQLite FTS5 index. The `synthesizePreferencesFromLcm()` function:

1. Queries LCM FTS for user messages matching the recall query
2. Detects preference signals via regex patterns (e.g., "I prefer X", "I really enjoy X", "my favorite X", "I'm interested in X")
3. Generates one clear statement per signal: *"The user enjoys using Adobe Premiere Pro for video editing"*
4. Returns a compact recall section with statements and source context

## Configuration

IRC is controlled by four config fields in `PluginConfig`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ircEnabled` | `boolean` | `true` | Enable/disable IRC entirely |
| `ircMaxPreferences` | `number` | `20` | Maximum preference signals to synthesize per recall |
| `ircIncludeCorrections` | `boolean` | `true` | Include user corrections as preference signals |
| `ircMinConfidence` | `number` | `0.3` | Minimum confidence threshold for Strategy 1 memories |

To disable IRC:

```json
{
  "ircEnabled": false
}
```

## Detected patterns

Strategy 2 recognizes these preference signal patterns (with optional adverbs):

- **Direct preferences**: "I prefer/enjoy/like/love/favor X"
- **Tool usage**: "I use/work with/code in X"
- **Favorites**: "my favorite/preferred/go-to X"
- **Conditional**: "I'd rather/I would prefer X"
- **Interest**: "I'm a fan of/into/interested in/passionate about X"

## Architecture

```
recallInternal()
  ├── ... (20+ other parallel recall sections)
  └── IRC section
      ├── Strategy 1: readAllMemories() → consolidatePreferences()
      │   └── Returns if extracted memories exist
      └── Strategy 2: synthesizePreferencesFromLcm()
          └── Fallback when no extracted memories
```

IRC is non-fatal: errors are caught and logged, never blocking recall.

## Key files

- `src/compounding/preference-consolidator.ts` — Core IRC logic (both strategies)
- `src/orchestrator.ts` — IRC integration in recall pipeline
- `src/types.ts` — IRC config fields
- `src/config.ts` — IRC config parsing
