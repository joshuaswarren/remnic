$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$stdinPayload = if ($MyInvocation.ExpectingInput) { ($input | Out-String) } else { [Console]::In.ReadToEnd() }
$stdinPayload | & node (Join-Path $scriptDir "remnic-codex-hook.cjs") @args
exit $LASTEXITCODE
