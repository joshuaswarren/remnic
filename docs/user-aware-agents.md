# User-Aware Agents

Remnic is open-source memory and context for user-aware agents. The user model
contract in `@remnic/core` is the typed surface for answering one question:

> What does the agent need to understand about this user to act well right now?

## User Model Dimensions

The public `USER_MODEL_DIMENSIONS` contract covers:

- preferences
- goals
- projects
- constraints
- current priorities
- communication style
- risk tolerance
- people and relationships
- past decisions
- definitions of good
- ask-before rules
- do-not-use-outside rules

These dimensions are broader than memory storage categories. They describe the
working context an agent needs before deciding whether to answer, ask, draft,
act, refuse, or escalate.

## Context Scopes

The public `USER_CONTEXT_SCOPES` contract covers:

- personal
- work
- client
- project
- repo
- tool
- temporary
- private
- do-not-use-outside-this-context

The existing `MemoryScope` type still means extraction routing scope
(`project` or `global`). User context scopes are different: they describe where
a user-model facet is safe and useful to apply. `temporary`, `private`, and
`do-not-use-outside-this-context` are boundary scopes and should force stricter
ask-versus-act decisions in later planning layers.

Useful principle:

> Personalization without boundaries becomes surveillance. Personalization with correction and control becomes agency.

## Retrieved Memory Provenance

`@remnic/core` also exports a `RetrievedMemoryProvenance` contract for recall
surfaces. It answers the operational questions a user-aware agent needs before
using a memory:

- Where did this memory come from?
- When was it created or updated?
- What namespace or user context scope does it belong to?
- Why was it retrieved for this request?
- How confident is Remnic in the memory?
- Is it stale, corrected, disputed, forgotten, or superseded?
- Is it safe to use in the current context?

Recall X-ray attaches this provenance per result when retrieval already loaded
the memory frontmatter. The concrete scope is always present as the namespace
or storage path. User context scopes are inferred from explicit in-memory
metadata when provided by callers and from existing tags such as `work`, `repo`,
`private`, and `do-not-use-outside-this-context`.

Boundary scopes affect the safety decision. Forgotten, rejected, quarantined,
and out-of-context `do-not-use-outside-this-context` memories are marked
`blocked`; stale, pending-review, superseded, archived, disputed, private, and
temporary memories are marked `requires-review` unless the current context
matches the boundary.

## Action Confidence

`@remnic/core` exports an `evaluateActionConfidence` helper for read-only
ask-versus-act decisions. It returns one of:

- `ask`
- `draft`
- `act`
- `refuse`
- `escalate`

The helper is an advisory interruption-budgeting surface, not an executor. It
uses confidence, provenance strength, scope match, staleness, correction
history, user rules, context readiness, and action risk to decide whether an
agent has enough context to proceed.

Public line:

> A good agent should spend the user's attention carefully.

The helper is exposed as:

- core: `evaluateActionConfidence(input)`
- HTTP: `POST /remnic/v1/action-confidence`
- MCP: `remnic.action_confidence` and legacy `engram.action_confidence`
- CLI: `remnic action-confidence`

## Memory Evals

`@remnic/bench` exports `MEMORY_EVAL_DIMENSIONS` as Remnic's shared eval
contract for user-aware memory. Public line:

> Agent memory without evals is vibes with a database.

The contract covers repeated-context reduction, unnecessary-clarification
reduction, retrieval correctness, stale-memory harm, scope respect,
ask-when-needed decisions, act-when-enough-context decisions, and
personalization quality. See [Memory Evals](memory-evals.md) for the full
dimension map, metrics, and quick benchmark coverage.

## ChatGPT Apps Demo

The existing Remnic MCP runtime exposes a local ChatGPT Apps-compatible memory
inspector as `remnic.chatgpt_memory_inspector` with a widget resource at
`ui://remnic/memory-inspector.v1.html`. It shows safe recall previews,
provenance, scope/safety signals, action-confidence guidance, and follow-up
prompts for correction, forget, and scoping flows. See
[ChatGPT Apps Demo](chatgpt-apps-demo.md).

## Agentic Commerce Demo

The `agentic-commerce-v1` scenario shows user-aware memory for buyer-facing
agents: brand preferences, fit, budget, exclusions, gift constraints, shipping
urgency, risk tolerance, and ask-before-checkout rules. It uses synthetic
catalog data and local trust-zone records, not live merchant access. See
[Agentic Commerce Demo](agentic-commerce-demo.md).

## Core Exports

`@remnic/core` exports:

- `USER_MODEL_CORE_QUESTION`
- `USER_MODEL_DIMENSIONS`
- `USER_CONTEXT_SCOPES`
- `USER_BOUNDARY_SCOPES`
- `normalizeUserModelDimension`
- `normalizeUserContextScope`
- `facetHasBoundary`
- `summarizeUserModelCoverage`
- `buildRetrievedMemoryProvenance`
- `normalizeRetrievedMemoryProvenance`
- `summarizeRetrievedMemoryProvenance`
- `evaluateActionConfidence`
- `renderActionConfidenceText`

This contract is intentionally host-agnostic. OpenClaw, Hermes, Codex, MCP, and
future adapters should consume the core model rather than defining their own
parallel user profile taxonomies.
