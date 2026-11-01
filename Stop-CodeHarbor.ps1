$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $ProjectRoot '.runtime\state'

function Stop-ByPidFile($name) {
    $pidPath = Join-Path $StateDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidPath)) { return }

    [int]$targetPid = 0
    $raw = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if (-not [int]::TryParse($raw, [ref]$targetPid) -or $targetPid -le 0) {
        Write-Warning "$name PID file is invalid, removing it."
        Remove-Item -LiteralPath $pidPath -Force
        return
    }

    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
        & taskkill.exe /PID $targetPid /T /F 2>$null | Out-Null
        Write-Output "Stopped $name (PID $targetPid)."
    } else {
        Write-Output "$name process (PID $targetPid) was already stopped."
    }
    Remove-Item -LiteralPath $pidPath -Force
}

Stop-ByPidFile 'codeharbor'
# code-server is a child of the node process, taskkill /T handles it,
# but clean up PID file anyway
$csPid = Join-Path $StateDir 'code-server.pid'
if (Test-Path -LiteralPath $csPid) { Remove-Item -LiteralPath $csPid -Force }

Write-Output 'CodeHarbor stopped.'
