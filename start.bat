@echo off
rem Starts the local server and opens it in Chrome. Close this window to stop.
cd /d "%~dp0"
if not exist server.js (
  echo This file can't run from inside the zip.
  echo Right-click the zip, choose Extract All, then open start.bat in the new folder.
  pause
  exit /b 1
)
set "NODE=node"
if exist node.exe set "NODE=%~dp0node.exe"
"%NODE%" server.js --open
pause
