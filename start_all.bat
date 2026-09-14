@echo off
chcp 65001 >nul
title UltBot Manager - Launcher
cd /d "%~dp0"

echo ============================================================
echo   UltBot Manager - Node server
echo ============================================================
echo.

echo [1/2] Запускаю Node-сервер (UltBot Manager)...
start "UltBot Manager - Node" cmd /k npm start
pause