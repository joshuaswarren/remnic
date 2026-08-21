## Summary

<!-- What changed and why? -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor
- [ ] Security / hardening

## Validation

- [ ] `npm run check-types`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `bash scripts/check-review-patterns.sh`
- [ ] Added/updated tests for behavior changes
- [ ] For retrieval/planner/cache/config changes: ran `docs/ops/pr-review-hardening-playbook.md`
- [ ] For high-risk memory/retrieval paths: ran `npm run test:entity-hardening`
- [ ] Ran `npm run review:cursor` locally, or documented why it was unavailable

## Changelog

- [ ] Added/updated `CHANGELOG.md` under `## [Unreleased]`
- [ ] Not needed (explain why)

## Risk assessment

- [ ] No secrets/tokens added
- [ ] Backwards compatibility considered
- [ ] Migration/config impact documented (if applicable)
- [ ] Zero-value semantics validated (`0` limits stay disabled, never coerced)
- [ ] Flag symmetry validated (`enabled=false` disables both write and read-path effects)
- [ ] Cache invalidation/coherency reviewed (cross-instance + concurrent updates)
- [ ] Promise chain resilience verified (serialized `.then()` chains recover from rejection)
- [ ] Loop iterator matches needed data (`.entries()` if key is used, not `.values()`)
- [ ] Namespace consistency verified (read/write paths use same resolution layer)
- [ ] Direct-write paths trigger reindex (bypassing extraction pipeline must update search index)
- [ ] Index-only additions confirmed after persistence (no phantom entries for rejected content)
- [ ] Config schema minimums honor documented disable-at-zero values
- [ ] Template-derived regexes escape literal parts (no match-everything patterns)
- [ ] Invalid user input rejected, not silently defaulted (CLI flags, MCP params, format values)
- [ ] Validation allow-lists match handled code paths (no accepted-but-unhandled values)
- [ ] Status filters cover ALL non-active states (superseded, archived, quarantined, rejected, pending_review)
- [ ] File replace operations are atomic (write-to-temp then rename, not delete-then-write)
- [ ] Documented config properties wired end-to-end (schema → provider → client → test)
- [ ] CI publish workflows have branch protection on workflow_dispatch

## Notes for reviewers

<!-- Anything specific you want reviewed closely -->

## PR workflow

- [ ] PR scope is narrow, or the split justification is explained here
- [ ] Synced with latest `main` before requesting AI review
- [ ] Batched review fixes by subsystem instead of micro-pushing
