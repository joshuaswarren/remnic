# Theory: Codex hooks without executable mode

## Problem

Codex runs Remnic hooks from commands in `hooks.json`.

The source launcher uses executable mode `0755`. Some install paths do not
preserve this mode. Direct startup then fails with `Permission denied`. Remnic
cannot recall or observe.

## Operating theory

The hook command must start its own process. Package file metadata cannot
control runtime behavior.

Each POSIX command must invoke `sh`. It must quote the `${PLUGIN_ROOT}` path.
This works with readable package modes, including mode `0644`. Windows keeps
its PowerShell command.

## Current strategy

Use `sh` for every POSIX event. Keep event names, matchers, timeouts, and
Windows commands unchanged.

A manifest test checks every event. A runtime test copies the launcher, sets
mode `0644`, and runs it through `sh`.

## Verification state

The manifest test failed against the direct startup commands.

All 49 Codex hook tests pass. A copied launcher with mode `0644` starts and
returns valid hook JSON.
