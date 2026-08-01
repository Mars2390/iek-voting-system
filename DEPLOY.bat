@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1_PATH=%SCRIPT_DIR%deploy.ps1"

if not exist "%PS1_PATH%" (
    echo ERROR: deploy.ps1 not found in %SCRIPT_DIR%
    echo Make sure DEPLOY.bat and deploy.ps1 are in the same folder.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1_PATH%"

endlocal
