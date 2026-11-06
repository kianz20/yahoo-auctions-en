@echo off
rem Starts the local server and opens it in Chrome. Close this window to stop.
cd /d "%~dp0"
node server.js --open
pause
