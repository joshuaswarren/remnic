# PR28: Resume-Bundle Builder

## Goal

Build deterministic resume bundles from the state Engram already knows how to
persist:

- transcript recovery health
- recent objective-state snapshots
- recent work products
- open commitments

This slice should assemble and persist a real bundle, but it should not yet
inject bundles back into recall or perform restore-time replay.

## Scope

- add a builder that assembles one bundle for a target `sessionKey`
- keep the builder deterministic and bounded
- persist the built bundle through an operator-facing CLI command
- keep all behavior behind the existing `creationMemoryEnabled` and
  `resumeBundlesEnabled` flags

## Acceptance

- `buildResumeBundleFromState(...)` returns a valid typed `ResumeBundle`
- the builder only pulls refs from the requested `sessionKey`
- transcript recovery health contributes bundle facts and risk flags
- objective-state failures and partial outcomes surface as risk flags
- open commitments become `nextActions` and commitment refs
- recent work products and snapshots become linked refs and key facts
- `openclaw engram resume-bundle-build` persists the assembled bundle
- disabled mode short-circuits cleanly instead of partially assembling state

## Non-Goals

- resume-bundle recall injection
- restore-time execution or replay
- ranking/prioritization beyond bounded recency ordering
- new feature flags for bundle synthesis
