@echo off
setlocal
echo [archived] run-echo-local.cmd no longer starts the legacy API. Use run-margin-local.cmd for the Margin Board.
set "ROOT=%~dp0"
set "NODE_HOME=%ROOT%.runtime\node-v22.23.1-win-x64"
if not exist "%NODE_HOME%\node.exe" (
  echo Node 22 runtime not found at "%NODE_HOME%".
  exit /b 1
)
set "PATH=%NODE_HOME%;%PATH%"
cd /d "%ROOT%"
"%NODE_HOME%\node.exe" scripts\run-legacy-api.js %*
