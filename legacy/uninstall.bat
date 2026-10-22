@echo off
setlocal EnableDelayedExpansion
title XP Thermal Service - Uninstaller
mode con: cols=72 lines=30
color 0F
chcp 65001 >nul 2>&1

echo.
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │         XP Thermal Print Service  ·  Uninstaller             │
echo   └──────────────────────────────────────────────────────────────┘
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo   ┌──────────────────────────────────────────────────────────────┐
    echo   │  This script requires Administrator privileges.              │
    echo   │  Right-click and choose "Run as administrator"               │
    echo   └──────────────────────────────────────────────────────────────┘
    echo.
    pause
    exit /b 1
)

PowerShell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall

echo.
pause
