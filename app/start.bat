@echo off
cd /d "%~dp0.."
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
node app\host.mjs
pause
