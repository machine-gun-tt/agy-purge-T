<#
.SYNOPSIS
  agy-purge 一键安装 / 卸载（Windows）

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Scope project
  .\install.ps1 -Grants
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('user', 'project')][string]$Scope = 'user',
  [switch]$Grants,
  [switch]$Uninstall,
  [switch]$PurgePrompt,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cli = Join-Path $root 'bin/agy-purge.mjs'

function Resolve-NodeRuntime {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:AGY_PURGE_NODE) { $candidates.Add($env:AGY_PURGE_NODE) }

  $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }

  $shim = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Antigravity/bin/agy-node.cmd'
  if (Test-Path -LiteralPath $shim) { $candidates.Add($shim) }

  $local = Join-Path $env:LOCALAPPDATA 'Programs/Antigravity/Antigravity.exe'
  if (Test-Path -LiteralPath $local) { $candidates.Add($local) }

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $isElectron = $candidate -like '*.exe' -and $candidate -match 'Antigravity\.exe$'
    if ($isElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }
    try {
      $probe = & $candidate -e "process.stdout.write(process.versions.node)" 2>$null
    } catch {
      $probe = $null
    } finally {
      if ($isElectron) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    }
    if ($LASTEXITCODE -eq 0 -and $probe) {
      $major = [int]("$probe".Trim().Split('.')[0])
      if ($major -ge 18) { return $candidate }
    }
  }
  throw '未找到可用的 Node.js（≥18）。装一个 Node，或设置 $env:AGY_PURGE_NODE。'
}

$node = Resolve-NodeRuntime
Write-Host "运行时: $node" -ForegroundColor DarkGray

$argsList = @()
if ($Uninstall) {
  $argsList += 'uninstall'
  if ($PurgePrompt) { $argsList += '--purge-prompt' }
} else {
  $argsList += 'install'
  $argsList += '--scope'
  $argsList += $Scope
  if ($Grants) { $argsList += '--grants' }
}
if ($Rest) { $argsList += $Rest }

& $node $cli @argsList
exit $LASTEXITCODE
