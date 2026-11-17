#!/usr/bin/env pwsh
# Thin PowerShell launcher for the unified Remnic Antigravity CLI (agy) hook runner.
# All logic lives in remnic-agy-hook.cjs. We resolve the runner relative to
# this script's own location and exec node, inheriting stdin (the hook payload)
# directly so the JSON is passed through byte-for-byte with no re-encoding.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir 'remnic-agy-hook.cjs'
& node $runner @args
exit $LASTEXITCODE
