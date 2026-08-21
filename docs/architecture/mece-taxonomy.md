# MECE Knowledge Directory with Resolver Decision Tree

Issue: #366

## What MECE means and why it matters

MECE stands for **Mutually Exclusive, Collectively Exhaustive**. Applied to
memory categorization, it means:

- **Mutually Exclusive** — every memory belongs to exactly one taxonomy
  category. There is no ambiguity about where a piece of knowledge lives.
- **Collectively Exhaustive** — the set of categories covers every possible
  type of knowledge. Nothing falls through the cracks.

Without MECE, duplicate filing and missed knowledge are common:
- A "principle" might end up in both `facts/` and `principles/`.
- A new type of knowledge might have no obvious home.

The taxonomy provides a single source of truth for how knowledge is organized,
and the resolver decision tree makes the filing process deterministic.

## Default taxonomy

| ID           | Name         | Priority | Memory Categories              |
|--------------|--------------|----------|--------------------------------|
| corrections  | Corrections  | 10       | correction                     |
| principles   | Principles   | 20       | principle, rule, skill         |
| entities     | Entities     | 30       | entity, relationship           |
| decisions    | Decisions    | 35       | decision, commitment           |
| preferences  | Preferences  | 40       | preference                     |
| facts        | Facts        | 50       | fact                           |
| moments      | Moments      | 60       | moment                         |

Priority is a tie-breaker: lower numbers take precedence when a memory could
plausibly belong to multiple categories.

## How to customize

### 1. Enable the feature

```json
{
  "taxonomyEnabled": true,
  "taxonomyAutoGenResolver": true
}
```

### 2. Add a custom category (CLI)

```bash
remnic taxonomy add research "Research" \
  --description "Research notes and findings" \
  --priority 45 \
  --memory-categories ""
```

### 3. Edit taxonomy.json directly

Create or edit `<memoryDir>/.taxonomy/taxonomy.json`:

```json
{
  "version": 2,
  "categories": [
    {
      "id": "research",
      "name": "Research",
      "description": "Research notes and academic findings",
      "filingRules": ["Research papers, literature reviews, study results"],
      "priority": 45,
      "memoryCategories": []
    }
  ]
}
```

User categories **merge** with defaults. To override a default category,
use the same `id` — your definition wins.

### 4. Remove a custom category

```bash
remnic taxonomy remove research
```

Default categories with mapped `memoryCategories` cannot be removed without
reassigning their mappings first.

## Resolver decision tree

The resolver follows this algorithm:

1. Look up which taxonomy categories accept the given `MemoryCategory`.
2. If exactly one match: return it with confidence 1.0.
3. If multiple matches: score by keyword overlap with filing rules, then
   tie-break by priority (lower number wins).
4. If no match: fall back to the "facts" category with low confidence.
5. Always return alternatives (other plausible categories).

Generate the human-readable decision tree:

```bash
remnic taxonomy resolver
```

This produces (and optionally saves) a RESOLVER.md document that walks
through each category in priority order.

## Config reference

| Property                    | Type    | Default | Description                                         |
|-----------------------------|---------|---------|-----------------------------------------------------|
| `taxonomyEnabled`           | boolean | false   | Enable the MECE taxonomy knowledge directory         |
| `taxonomyAutoGenResolver`   | boolean | true    | Auto-regenerate RESOLVER.md when taxonomy changes    |

## CLI commands

```
remnic taxonomy show [--json]                     Show current taxonomy
remnic taxonomy resolver                          Print/regenerate RESOLVER.md
remnic taxonomy add <id> <name> [options]         Add a custom category
remnic taxonomy remove <id>                       Remove a custom category
remnic taxonomy resolve <text> [--category <cat>] Test resolver on sample text
```
