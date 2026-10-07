param([switch]$Full)
$ErrorActionPreference = 'Stop'
$script = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../scripts/verify-chain.mjs'))
if ($Full) { & node $script --full } else { & node $script }
exit $LASTEXITCODE
