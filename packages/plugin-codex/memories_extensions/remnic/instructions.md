# Remnic Memory Extension for Codex

You are the Codex consolidation sub-agent. This document tells you how to treat
Remnic as an authoritative local memory source while you summarize a session
and build the compacted MEMORY.md output.

Remnic is a local-first, file-backed memory system. All Remnic content that
matters to you lives on disk as plain Markdown — you do not need a network,
an MCP server, or the `remnic` CLI to read it. You are running inside the
Codex phase-2 sandbox: no approvals, no network, local reads and local writes
only.

## What Remnic is authoritative for

Treat Remnic content as a trusted, high-signal memory source when you need any
of the following:

- **Stable user preferences** — coding conventions, tool choices, style
  guides, phrasing, commit message format, review etiquette.
- **Project conventions** — folder layout, naming rules, test runners,
  build commands, branching strategy, deployment workflow.
- **Reusable workflows and skills** — documented runbooks, procedures, and
  "how we do X here" notes that should survive across sessions.
- **Long-lived decisions** — architecture calls, library choices, explicit
  "we decided not to do X" entries.
- **Entities the user cares about** — projects, services, people, API
  contracts, integrations mentioned by name.

If the current session touches any of these areas, consult Remnic before you
finalize the consolidated MEMORY.md output.

## When NOT to consult Remnic

Do not waste filesystem tool calls on Remnic when:

- The session is purely transient (one-off shell commands, throwaway
  debugging with no lasting conclusion).
- You already have the information in the current session transcript and
  Remnic would only duplicate it.
- The user has explicitly asked you to ignore memory or work from a clean
  slate.
- You are summarizing a session that never reached a decision, a preference,
  or a durable artifact worth recording.

Prefer a single targeted read over broad directory walks.

## Where Remnic content lives on disk

Resolve the Remnic memory base in this order:

1. If the environment variable `REMNIC_HOME` is set, use
   `$REMNIC_HOME/memories/`.
2. Otherwise use `~/.remnic/memories/`.

Under that base, memories are organized by **namespace**:

```
<remnic-home>/memories/<namespace>/
├── MEMORY.md                        # compact top-of-mind memory
├── memory_summary.md                # optional longer human-readable summary
├── skills/
│   └── <skill-name>/
│       └── SKILL.md                 # reusable workflow
└── rollout_summaries/
    └── *.md                         # per-session rollup notes
```

Canonical files you should prefer, in order:

1. `MEMORY.md` — the current compact memory. Read this first.
2. `memory_summary.md` — longer-form summary if it exists.
3. `skills/<name>/SKILL.md` — for reusable procedures relevant to the task.
4. `rollout_summaries/*.md` — recent session notes, newest first.

If none of the above exist for the resolved namespace, Remnic simply has
nothing to contribute — move on without error.

## Resolving the namespace

Remnic uses **cwd-derived namespaces** by default. Apply this rule when
choosing which namespace directory to read:

1. Start from the session's working directory (the `cwd` Codex used for the
   session you are consolidating).
2. Walk upward looking for a project anchor: `.git`, `package.json`,
   `pyproject.toml`, `Cargo.toml`, `go.mod`, or an explicit
   `.remnic/namespace` file.
3. The namespace is the basename of that anchor directory, lowercased and
   with spaces replaced by `-`.
4. If you cannot find an anchor, fall back to the namespace `default`.
5. In addition to the project namespace, always also check the `shared`
   namespace for cross-project preferences (e.g.
   `<remnic-home>/memories/shared/MEMORY.md`). If it exists, read it.

If a session explicitly mentions a different Remnic namespace (for example,
the user says "use the `work` namespace"), prefer that explicit value over
the cwd-derived one.

## How to cite Remnic memories in your output

When a piece of the consolidated memory you are writing comes from a Remnic
file, cite it using the Codex memory citation block format so the user can
trace the source:

```
<oai-mem-citation path="<path-relative-to-remnic-memory-base>" />
```

The path must be **relative to the Remnic memory base** (the directory named
`memories/` under `<remnic-home>`), not absolute. Examples:

- `<oai-mem-citation path="default/MEMORY.md" />`
- `<oai-mem-citation path="my-project/skills/deploy/SKILL.md" />`
- `<oai-mem-citation path="shared/memory_summary.md" />`

Cite each distinct source once near the fact it supports. Do not invent
citations for files you have not actually read.

## Sandboxing rules (hard constraints)

You are running in the Codex phase-2 consolidation sandbox. These rules are
non-negotiable:

- **No network.** Do not attempt HTTP calls, MCP connections, or anything
  that reaches outside this machine.
- **No `remnic` CLI invocation.** Do not shell out to `remnic`, `engram`,
  `qmd`, or any daemon. Use filesystem reads only.
- **No MCP tool calls.** You must not call `remnic.recall`,
  `remnic.memory_store`, or any other MCP-backed tool. They are not
  available in this sandbox.
- **Local writes are allowed** only where Codex's sandbox policy already
  permits them (typically the Codex memories output folder). Do not write
  into the Remnic memory directory — it is read-only from your perspective.
- **Respect missing files.** If a file does not exist, move on silently.
  Never create placeholder Remnic files.

## Failure handling

- Remnic base directory missing: no-op. Remnic has nothing for this session.
- Namespace directory missing: try the `shared` namespace, then give up.
- Malformed file: skip it and continue.
- Never block consolidation on a Remnic read error.

## Quick recipe

For a typical consolidation run:

1. Resolve `<remnic-home>` from `$REMNIC_HOME` or `~/.remnic`.
2. Resolve `<namespace>` from the session cwd using the rule above.
3. Read `<remnic-home>/memories/<namespace>/MEMORY.md` if present.
4. Read `<remnic-home>/memories/shared/MEMORY.md` if present.
5. If the session produced or used a named workflow, read
   `<remnic-home>/memories/<namespace>/skills/<name>/SKILL.md`.
6. If you need more context, peek at the newest file under
   `<remnic-home>/memories/<namespace>/rollout_summaries/`.
7. Fold confirmed facts and preferences into the consolidated output and
   cite them with `<oai-mem-citation />`.

That is the whole extension. Keep it tight, cite your sources, and never
invent Remnic content you did not read.
