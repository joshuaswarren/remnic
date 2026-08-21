# Developer Workflow Demo

Remnic's developer workflow demo shows how user-aware memory helps coding
agents plan changes, modify repositories, run checks, and review work with less
repeated setup context.

The demo is local and synthetic. It does not require a live Codex, Cursor,
Cognition, or LangChain integration. It uses the existing coding-agent memory
path and the deterministic `coding-recall` benchmark.

## What It Models

The demo covers developer-agent context that should be remembered across
sessions:

- repo conventions
- preferred architecture patterns
- test expectations
- release process
- common failure modes
- past bugs
- review preferences
- "ask before changing public API" rules
- "always run these checks" rules

The point is not to make an agent ask zero questions. The point is to make the
agent spend attention on the questions that matter: risky API changes,
conflicting memories, missing context, or actions that cross a user-defined
boundary.

## Existing Remnic Surfaces

This demo builds on shipped Remnic behavior:

- Coding agent mode scopes memory to a git project and optionally a branch.
- Global fallback can surface cross-project user preferences without leaking
  project-specific details.
- Diff-aware review-context recall boosts memories tied to touched files.
- Action confidence can represent "ask", "draft", "act", "refuse", or
  "escalate" for risky developer actions.
- Recall X-ray and provenance explain why a memory was retrieved and whether it
  is safe to use in the current context.

## Evaluate It

Run the deterministic benchmark:

```bash
remnic bench run --quick coding-recall
```

Quick mode keeps a developer workflow case at the front of the smoke fixture so
task-capped CLI runs still exercise workflow memory. Full mode includes both
developer workflow cases plus the existing project, branch, and review-context
isolation cases.

The `developer-workflow-change-plan` case asserts that planning a public API
change recalls architecture boundaries, test gates, release process, review
preferences, and ask-before-public-API rules without pulling in another repo's
memory.

The `developer-workflow-review-risk` case asserts that review recall boosts
past bugs and common failure modes for touched files, while still respecting
project boundaries.

Developer workflow cases report `workflow_coverage`, which measures whether
the retrieved context covers the required developer workflow facets.

## Demo Prompt Shape

Use prompts like these against a project-scoped store:

```text
Plan a change to the Remnic core public API for a new memory field. Use the
repo conventions, architecture boundaries, release process, and test
expectations you know. Ask before making irreversible public API changes.
```

```text
Review this PR touching packages/remnic-core/src/storage.ts. Surface prior bugs,
common failure modes, and the checks I expect before merge.
```

A good agent should recall the repository's architecture boundary before
editing core, run the expected gates before claiming merge readiness, and ask
before changing public API behavior.
