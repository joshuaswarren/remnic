# PR27: Resume Bundle Format

## Goal

Add a deterministic, typed resume-bundle store so crash-recovery handoff data has
a stable on-disk contract before any automated builder logic lands.

## Scope

- add `resumeBundlesEnabled` and `resumeBundleDir` config flags
- add a typed `ResumeBundle` schema and dated storage layout
- add operator-facing `openclaw engram resume-bundle-status`
- add operator-facing `openclaw engram resume-bundle-record`
- document the format-first boundary in README/config docs

## Non-Goals

- transcript synthesis
- objective-state to bundle assembly
- commitment summarization into bundles
- automatic builder or recovery injection

## Why This Slice

PR23 and PR25 established the typed ledgers for created outputs and obligations.
PR27 extends that creation-memory track with the crash-recovery container itself.
The bundle format needs to exist before PR28 can safely build it from live
session state.

## Acceptance Criteria

- resume bundles persist under `{memoryDir}/state/resume-bundles/bundles/YYYY-MM-DD`
- invalid bundle files are surfaced in status output without failing the command
- CLI record/status commands no-op cleanly when the feature flag is disabled
- config contract and type surface include the new flag and directory
- no automatic bundle-building behavior is introduced in this slice
