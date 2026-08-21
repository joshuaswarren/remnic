# Remnic Namespace Cheatsheet

Remnic partitions memories into **namespaces** so multiple projects and
contexts can share a single Remnic home without bleeding into each other.
When the Codex consolidation sub-agent reads Remnic files, it has to pick
the right namespace directory for the session it is summarizing. This
cheatsheet documents the resolution rule.

## Resolution rule (in order)

1. **Explicit override in the session.** If the user or the transcript
   explicitly names a Remnic namespace, use that value verbatim.
2. **Project anchor walk.** Starting from the session's working directory,
   walk upward until you find any of:
   - `.git/`
   - `.remnic/namespace` file (highest priority if present)
   - `package.json`
   - `pyproject.toml`
   - `Cargo.toml`
   - `go.mod`
   Use the basename of the anchor directory, lowercased, with whitespace
   replaced by `-`.
3. **Fallback.** If nothing above matches, use the namespace `default`.
4. **Shared overlay.** In addition to the resolved namespace, always also
   check the `shared` namespace for cross-project content.

## Examples

| Session cwd                              | Anchor               | Namespace       |
|------------------------------------------|----------------------|-----------------|
| `/home/user/code/my-app/src`             | `/home/user/code/my-app/.git`     | `my-app`        |
| `/home/user/code/Data Pipeline`          | `.git`               | `data-pipeline` |
| `/tmp/scratch`                           | (none)               | `default`       |
| `/work/research/` (contains `.remnic/namespace` = `lab`) | `.remnic/namespace` | `lab`  |

## Why it matters

If the consolidation agent reads from the wrong namespace, it will either
miss relevant project-specific memories (false negative) or drag unrelated
content into the summary (false positive). Getting the namespace right keeps
Remnic's signal-to-noise ratio high.

## What the extension does with this

The consolidation sub-agent reads `MEMORY.md`, `memory_summary.md`, any
relevant `skills/<name>/SKILL.md`, and newest `rollout_summaries/*.md`
under the resolved namespace, plus the `shared` namespace overlay. All
reads are filesystem-only — no CLI, no network, no MCP.
