@echo off
rem #region Header
rem // Start Ember OS.bat
rem // Author: James LaFritz
rem // Description: Starts the Ember OS Node.js server and opens the local dashboard.
rem #endregion

title Ember OS Server

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found in PATH.
    echo Install Node.js or add node.exe to PATH, then try again.
    pause
    exit /b 1
)

if not exist "server.js" (
    echo server.js was not found in:
    echo %CD%
    pause
    exit /b 1
)

start "" "http://localhost:4517"
node server.js

echo.
echo Ember OS server stopped.
pause
