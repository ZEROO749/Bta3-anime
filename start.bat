@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed / برنامج Node.js غير مثبت
  echo  Download it from: https://nodejs.org  ^(choose LTS^) then run this file again.
  echo.
  pause
  exit /b 1
)
node server\server.js
echo.
pause
