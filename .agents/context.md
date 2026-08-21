# Agent Context — openclaw-engram

Quick reference for agents working on this repository.

## What This Is

A TypeScript plugin for the OpenClaw AI gateway that gives agents persistent, searchable memory across conversations. See `AGENTS.md` (root) for the full guide.

## Key Constraints

- PUBLIC repo — never commit personal data, API keys, or memory content (see `CLAUDE.md`)
- TypeScript strict mode — `npm run lint` must pass
- Tests must pass — `npm test` before any PR
- OpenAI Responses API only — no Chat Completions (see `src/extraction.ts`)
- Active v8.2 work in `orchestrator.ts`, `graph.ts`, `tmt.ts` — coordinate before touching

## Quick Commands

```bash
npm run lint              # TypeScript type check
npm test                  # Full test suite
npm run build             # Compile to dist/
npm run preflight:quick   # Fast pre-PR gate
npm run preflight         # Full pre-PR gate
npm run check-config-contract  # Verify config schema alignment
```

## Critical Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | Full agent guide with invariants |
| `CLAUDE.md` | Privacy policy and architecture notes |
| `src/AGENTS.md` | Source-specific agent notes |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/CONVENTIONS.md` | Coding conventions |
| `docs/tech-stack.md` | Tech stack reference |
| `docs/config-reference.md` | Config options reference |
