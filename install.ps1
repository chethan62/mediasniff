#Requires -Version 5.1
<#
  MediaSniff - Windows installer.

  The extension (MV3) and the helper (helper/grab.py, pure Python stdlib) are
  cross-platform. This script sets up the Windows-native pieces:
    - installs N_m3u8DL-RE (win-x64) to %LOCALAPPDATA%\Programs\mediasniff
    - checks for yt-dlp / ffmpeg (suggests winget)
    - registers the Grab helper to autostart at logon (Scheduled Task, windowless)
    - verifies the helper /health and detects ABDM

  Run from the repo folder:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Requires Python 3 (winget install Python.Python.3.12).
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = $PSScriptRoot
$Bin  = Join-Path $env:LOCALAPPDATA 'Programs\mediasniff'
$Port = 15152
$Task = 'MediaSniffGrabber'
$UA   = @{ 'User-Agent' = 'mediasniff-installer' }

function Log  ($m) { Write-Host "[mediasniff] $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "[mediasniff] WARN: $m" -ForegroundColor Yellow }
function Have ($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Log "repo: $Repo"

# 1. Python (required)
if (-not (Have 'python')) {
  Warn 'Python not found. Install it (winget install Python.Python.3.12), then re-run.'
  exit 1
}
$py  = (Get-Command python).Source
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { $pyw = $py }

# 2. yt-dlp / ffmpeg (recommended)
foreach ($c in 'yt-dlp','ffmpeg') {
  if (Have $c) { Log "$c`: ok" } else { Warn "$c missing - install:  winget install $c   (or: scoop install $c)" }
}

# 3. N_m3u8DL-RE (win-x64)
$nm = Join-Path $Bin 'N_m3u8DL-RE.exe'
if ((Have 'N_m3u8DL-RE') -or (Test-Path $nm)) {
  Log 'N_m3u8DL-RE: ok'
} else {
  Log 'installing N_m3u8DL-RE (win-x64) ...'
  $rel = Invoke-RestMethod 'https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest' -Headers $UA
  $asset = $rel.assets | Where-Object { $_.name -match 'win-x64' -and $_.name -match '\.zip$' } | Select-Object -First 1
  if (-not $asset) {
    Warn 'no win-x64 asset found in the latest release'
  } else {
    $zip = Join-Path $env:TEMP 'nm_re.zip'
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip -Headers $UA
    Expand-Archive -Path $zip -DestinationPath $Bin -Force
    Remove-Item $zip -Force
    if (-not (Test-Path $nm)) {
      $found = Get-ChildItem -Path $Bin -Recurse -Filter 'N_m3u8DL-RE.exe' | Select-Object -First 1
      if ($found) { Move-Item $found.FullName $nm -Force }
    }
    if (Test-Path $nm) { Log "N_m3u8DL-RE -> $nm" } else { Warn "extracted but N_m3u8DL-RE.exe not found under $Bin" }
  }
}

# Put $Bin on user PATH + expose MEDIASNIFF_BIN (so the helper finds the tool even before a PATH refresh)
$uPath = [Environment]::GetEnvironmentVariable('Path','User')
if (-not $uPath) { $uPath = '' }
if ($uPath -notlike "*$Bin*") {
  [Environment]::SetEnvironmentVariable('Path', ($uPath.TrimEnd(';') + ';' + $Bin), 'User')
  Log "added $Bin to user PATH (new terminals will see it)"
}
[Environment]::SetEnvironmentVariable('MEDIASNIFF_BIN', $Bin, 'User')

# 4. build note
Log 'Chrome/Edge load the repo root directly (no build needed). Firefox: run "npm run build" in Git Bash/WSL.'

# 5. autostart helper (Scheduled Task at logon, windowless via pythonw)
$grab = Join-Path $Repo 'helper\grab.py'
Log "registering autostart task '$Task' ..."
$action  = New-ScheduledTaskAction -Execute $pyw -Argument ('"{0}"' -f $grab)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $set -Force `
  -Description 'MediaSniff Grabber - local HLS/DASH download helper' | Out-Null
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 3

# 6. verify helper
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Log ("helper UP: " + ($h | ConvertTo-Json -Compress))
} catch {
  Warn "helper not responding on :$Port yet (it starts at logon). Run now:  & `"$pyw`" `"$grab`""
}

# 7. ABDM (optional; DM button)
try {
  Invoke-RestMethod 'http://127.0.0.1:15151/queues' -TimeoutSec 3 | Out-Null
  Log 'ABDM detected on :15151 (DM button ready)'
} catch {
  Warn 'ABDM not running (optional; DM = direct files). Windows build: https://abdownloadmanager.com'
}

Write-Host ''
Log 'Done. Load the extension (the one manual step):'
Write-Host "  Chrome:  chrome://extensions     Edge:  edge://extensions"
Write-Host "    -> enable Developer mode -> Load unpacked -> $Repo"
Write-Host ''
Write-Host "  Grab -> HLS/DASH via N_m3u8DL-RE -> Downloads (live progress)"
Write-Host "  DM   -> direct files via AB Download Manager"
Write-Host "  Manage the helper task:  Get-ScheduledTask $Task | Format-List ;  Start-ScheduledTask $Task ;  Unregister-ScheduledTask $Task"
