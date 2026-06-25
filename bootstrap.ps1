#Requires -Version 5.1
<#
  MediaSniff bootstrap (Windows) — clone the repo, then run install.ps1.

  One command:
    irm https://raw.githubusercontent.com/chethan62/mediasniff/main/bootstrap.ps1 | iex

  Env: MEDIASNIFF_DIR  where to clone (default %USERPROFILE%\mediasniff)
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = 'https://github.com/chethan62/mediasniff.git'
$Dest = if ($env:MEDIASNIFF_DIR) { $env:MEDIASNIFF_DIR } else { Join-Path $env:USERPROFILE 'mediasniff' }

function Log($m) { Write-Host "[mediasniff] $m" -ForegroundColor Cyan }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host '[mediasniff] git is required — winget install Git.Git, then re-run.' -ForegroundColor Red
  return
}

if (Test-Path (Join-Path $Dest '.git')) {
  Log "updating existing checkout: $Dest"
  git -C $Dest pull --ff-only
} else {
  Log "cloning into: $Dest"
  git clone --depth 1 $RepoUrl $Dest
}

Log 'running installer ...'
powershell -ExecutionPolicy Bypass -File (Join-Path $Dest 'install.ps1')
