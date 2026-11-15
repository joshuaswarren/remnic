#!/usr/bin/env pwsh
# Thin PowerShell launcher for the unified Remnic Devin CLI hook runner.
# All logic lives in remnic-devin-hook.cjs. We resolve the runner relative to
# this script's own location and exec node, inheriting stdin (the hook payload)
# directly so the JSON is passed through byte-for-byte with no re-encoding.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir 'remnic-devin-hook.cjs'
& node $runner @args
exit $LASTEXITCODE
