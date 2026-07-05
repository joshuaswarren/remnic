#!/usr/bin/env pwsh
# Thin PowerShell launcher for the unified Remnic Claude Code hook runner (#1518).
# All logic lives in remnic-cc-hook.cjs. We resolve the runner relative to
# this script's own location and exec node, inheriting stdin (the hook payload)
# directly so the JSON is passed through byte-for-byte with no re-encoding.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir 'remnic-cc-hook.cjs'
& node $runner @args
exit $LASTEXITCODE
