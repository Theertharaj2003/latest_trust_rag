@echo off
setlocal
cd /d "%~dp0"
set "TRUSTRAG_PORT=8001"
if not "%~1"=="" set "TRUSTRAG_PORT=%~1"
if not exist ".venv\Scripts\python.exe" (
  echo [TrustRAG] Creating virtual environment...
  py -3 -m venv .venv 2>nul
  if errorlevel 1 python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
  echo Install Python 3.10+ and ensure py or python is available.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements/local.txt
if errorlevel 1 (
  echo Could not install dependencies. Please read the pip error above.
  pause
  exit /b 1
)
echo [TrustRAG] Open http://127.0.0.1:%TRUSTRAG_PORT% after startup.
echo [TrustRAG] Port already used? Run start.bat 8002
".venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port %TRUSTRAG_PORT%
endlocal
