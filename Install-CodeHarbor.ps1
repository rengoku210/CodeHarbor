$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
$CachePath = Join-Path $RuntimeRoot 'npm-cache'
New-Item -ItemType Directory -Force -Path $CachePath | Out-Null
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js is required. Install Node.js 20 or newer, then run this script again.' }
$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $NpmCommand) { throw 'npm.cmd was not found. Repair the Node.js installation so npm is available on PATH.' }
Push-Location $ProjectRoot
try {
    & $NpmCommand.Source install --no-audit --no-fund --cache "`"$CachePath`""
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
Write-Output 'CodeHarbor editor dependencies are ready.'
