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

This contract is intentionally host-agnostic. OpenClaw, Hermes, Codex, MCP, and
future adapters should consume the core model rather than defining their own
parallel user profile taxonomies.
