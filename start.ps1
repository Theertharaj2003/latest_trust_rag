param([int]$Port = 8001)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path '.venv\Scripts\python.exe')) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv .venv }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { python -m venv .venv }
    else { throw 'Python 3.10+ is required. Install Python and retry.' }
}
if (-not (Test-Path '.venv\Scripts\python.exe')) { throw 'Could not create .venv.' }
& .venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check pip output.' }
Write-Host "TrustRAG: http://127.0.0.1:$Port (Ctrl+C to stop)"
Write-Host 'Port in use? Run: .\start.ps1 -Port 8002'
& .venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port $Port
