#!/usr/bin/env pwsh
# Thin PowerShell launcher for the unified Remnic Codex hook runner (issue #1440).
# All logic lives in remnic-codex-hook.cjs. We resolve the runner relative to
# this script's own location and exec node, inheriting stdin (the hook payload)
# directly so the JSON is passed through byte-for-byte with no re-encoding.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir 'remnic-codex-hook.cjs'
& node $runner @args
exit $LASTEXITCODE
