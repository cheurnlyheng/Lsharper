@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found in PATH & pause & exit /b)
node server.js --open
pause
