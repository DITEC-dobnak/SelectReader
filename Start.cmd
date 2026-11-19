@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chyba: vyzaduje sa Node.js 22 alebo novsi.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
