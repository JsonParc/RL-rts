param(
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $repoRoot '.auto-commit.pid'
$stdoutPath = Join-Path $repoRoot 'auto-commit.stdout.log'
$stderrPath = Join-Path $repoRoot 'auto-commit.stderr.log'
$scriptPath = Join-Path $PSScriptRoot 'auto-commit.js'

if (Test-Path $pidPath) {
    $existingPidRaw = (Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($existingPidRaw) {
        $existingProcess = Get-Process -Id ([int]$existingPidRaw) -ErrorAction SilentlyContinue
        if ($existingProcess) {
            Write-Output "Auto-commit watcher already running (PID $existingPidRaw)."
            exit 0
        }
    }

    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
}

$arguments = @($scriptPath)
if ($Push) {
    $arguments += '--push'
}

$process = Start-Process `
    -FilePath 'node' `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -Path $pidPath -Value $process.Id

if ($Push) {
    Write-Output "Started auto-commit watcher with auto-push (PID $($process.Id))."
} else {
    Write-Output "Started auto-commit watcher (PID $($process.Id))."
}
