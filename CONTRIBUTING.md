# Contributing to Remnic

Thanks for contributing. Issues and pull requests are welcome from humans and AI-assisted contributors alike.

## Ways to contribute

- Report bugs or propose features via [GitHub Issues](https://github.com/joshuaswarren/remnic/issues)
- Submit pull requests for fixes, docs, tests, and improvements
- Improve examples and docs to help adoption

## Before opening a PR

1. Search existing issues and PRs to avoid duplicates.
2. For non-trivial changes, open an issue first and propose the approach and scope.
3. Keep PRs narrow: one subsystem group per PR. If work spans schema/surface contracts, storage/serialization, and retrieval behavior, split it before review.

## Claiming an issue

Issues are worked first-come, first-served — by humans and automated agents alike. To reserve an issue:

1. Comment on the issue stating you are taking it.
2. Self-assign the issue (or ask a maintainer to assign you).
3. A maintainer will apply the `contributor-claimed` label.

A claimed issue is off-limits to everyone else, including this repository's automated maintenance agents; they check labels, assignees, and comments before picking issues and again before opening or merging any PR. If your PR references a claimed issue (`Fixes #<n>`), maintainers will hold it for your review before merging anything else against it.

If you stop working on a claimed issue, comment to release it so someone else can pick it up. Stale claims (no activity for ~30 days) may be released by a maintainer after a ping.

## Development setup

Requires Node.js `>=22.12.0` and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install
pnpm run build
npm run check-types
npm test
```

Install the local guard hooks (recommended):

```bash
npm run hooks:install
```

This wires `pre-commit` to `npm run preflight:quick` and `pre-push` to `npm run preflight`.

## Quality gates

- `npm run preflight:quick` — fast gate (types + config contract + key tests). Run before every push.
- `npm run preflight` — full pre-PR gate (types + contract + tests + build).
- `npm run check-config-contract` — required when you touch config types, `parseConfig`, or the plugin manifest schema.
- `npm run check:docs-parity` — required when you touch docs that contain CLI commands; every fenced `remnic <cmd>` must be a real registered command.
- `npm run test:entity-hardening` — required when you touch `orchestrator.ts`, `storage.ts`, `intent.ts`, `memory-cache.ts`, `entity-retrieval.ts`, `config.ts`, or anything under `storage/` or `orchestration/`.

For retrieval/planner/cache/config changes, also run the mandatory hardening gate described in [docs/ops/pr-review-hardening-playbook.md](docs/ops/pr-review-hardening-playbook.md).

## PR quality bar

A good PR:

- Includes tests for behavior changes — tests must verify behavior, not pass vacuously
- Keeps backwards compatibility unless the change is intentionally breaking (and labeled as such)
- Avoids unrelated refactors
- Updates docs for user-facing or config changes
- Updates `CHANGELOG.md` (see below)

Reviewers of retrieval/planner/caching logic verify: flag symmetry (`enabled=false` disables write and read effects), zero semantics (`0` is never coerced to `1`), cap-after-filter ordering, cache coherence across instances, fallback parity with primary search policy, artifact isolation, planner mode reachability, and heuristic robustness across language variants.

## Changelog policy

`CHANGELOG.md` on `main` is the contributor-facing ledger for upcoming release notes; published per-version notes ship through GitHub Releases.

- Add a concise entry under `## [Unreleased]` for user-facing changes, using `Added`, `Changed`, `Fixed`, or `Security`.
- A CI check enforces this when source or config files change; maintainers can bypass with the `skip-changelog` label.

## AI-assisted contributions

AI-assisted and agent-assisted PRs are welcome. Please ensure:

- A human reviews and stands behind the final PR
- Generated code is understood, minimal, and tested
- No secrets, tokens, or private data are introduced

Agents working in this repo should read [AGENTS.md](AGENTS.md) — it contains the binding engineering guardrails and review-prevention patterns.

## Security

Do not submit secrets in code, issues, or PRs. For sensitive vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting exploit details publicly.

## Release process

Merges to `main` trigger the automated release workflow: it validates (types, tests, build), derives the version bump from PR labels (`major`/`breaking-change` → major, `feature`/`enhancement` → minor, otherwise patch), tags `vX.Y.Z`, creates a GitHub release, and publishes the public packages in dependency order. See [docs/development/release-process.md](docs/development/release-process.md).

## More

- [docs/development/contributing.md](docs/development/contributing.md) — deeper contributor reference
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — code and testing conventions
- [docs/architecture/monorepo-structure.md](docs/architecture/monorepo-structure.md) — package map

Good first contributions: better error messages, additional regression tests, example configs for common providers, and performance or safety improvements with benchmarks.

Thanks again for improving Remnic.
