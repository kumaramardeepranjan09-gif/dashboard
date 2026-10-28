@echo off
title SmartPredict Dashboard Launcher
echo ========================================================
echo       SmartPredict Predictive Maintenance Dashboard
echo ========================================================
echo.
echo 1. Launching local dashboard server (http://localhost:8080/)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"

if errorlevel 1 (
    echo Falling back to direct browser launch...
    start "" "%~dp0dashboard\index.html"
)

pause
