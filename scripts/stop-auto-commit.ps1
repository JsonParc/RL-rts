$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $repoRoot '.auto-commit.pid'

if (-not (Test-Path $pidPath)) {
    Write-Output 'Auto-commit watcher is not running.'
    exit 0
}

$pidRaw = (Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($pidRaw) {
    $process = Get-Process -Id ([int]$pidRaw) -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id ([int]$pidRaw) -Force
        Write-Output "Stopped auto-commit watcher (PID $pidRaw)."
    } else {
        Write-Output 'Auto-commit watcher PID file was stale.'
    }
}

Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
