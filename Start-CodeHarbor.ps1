param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $ProjectRoot '.runtime\state'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# check if already running
$PidPath = Join-Path $StateDir 'codeharbor.pid'
if (Test-Path -LiteralPath $PidPath) {
    $oldPid = (Get-Content -LiteralPath $PidPath -Raw).Trim()
    $running = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($running -and $running.ProcessName -match 'node') {
        Write-Output "CodeHarbor is already running (PID $oldPid)."
        Write-Output "Open http://127.0.0.1:4170/ in your browser."
        exit 0
    }
}

Push-Location $ProjectRoot
try {
    $ServerPath = Join-Path $ProjectRoot 'server.js'
    $proc = Start-Process -FilePath 'node.exe' -ArgumentList @("`"$ServerPath`"") `
        -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $StateDir 'codeharbor.stdout.log') `
        -RedirectStandardError (Join-Path $StateDir 'codeharbor.stderr.log')

    Set-Content -LiteralPath $PidPath -Value $proc.Id

    Write-Output "CodeHarbor started (PID $($proc.Id))"
    Write-Output "Waiting for code-server to initialize..."

    # wait for the server to be ready
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4170/codeharbor/health' -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
    }

    if ($ready) {
        Write-Output "CodeHarbor is ready at http://127.0.0.1:4170/"
        if (-not $NoBrowser) {
            Start-Process 'http://127.0.0.1:4170/'
        }
    } else {
        Write-Warning "CodeHarbor started but may still be initializing. Check .runtime/state/ logs."
        Write-Output "Try opening http://127.0.0.1:4170/ manually."
    }
} finally { Pop-Location }
