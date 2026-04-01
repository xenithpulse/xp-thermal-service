@echo off
setlocal EnableDelayedExpansion
title XP Thermal Print Service - Setup
mode con: cols=74 lines=50
color 0F
chcp 65001 >nul 2>&1

echo.
echo   +================================================================+
echo   ::                                                              ::
echo   ::    XP Thermal Print Service                                  ::
echo   ::    Enterprise Setup v2.2                                     ::
echo   ::                                                              ::
echo   ::    Powered by XenithPulse.com                                ::
echo   ::                                                              ::
echo   +================================================================+
echo.

REM -- Admin check -------------------------------------------------------
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo   +----------------------------------------------------------------+
    echo   ::  This installer requires Administrator privileges.            ::
    echo   ::                                                              ::
    echo   ::  Right-click setup.bat and choose "Run as administrator"     ::
    echo   +----------------------------------------------------------------+
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"

REM -- Preparing environment ---------------------------------------------
echo   Preparing Environment
echo   ----------------------------------------------------------------
echo.
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo        X  Node.js is not installed.
    echo           Download v18+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo        OK  Node.js %NODE_VER%

echo        ..  Installing dependencies...
call npm install --silent >nul 2>&1
if %errorLevel% neq 0 (
    echo        X  npm install failed. Check your network connection.
    echo.
    pause
    exit /b 1
)
echo        OK  Dependencies installed

echo        ..  Building service...
call npm run build >nul 2>&1
if %errorLevel% neq 0 (
    echo        X  Build failed. Check for TypeScript errors.
    echo.
    pause
    exit /b 1
)
echo        OK  Build complete
echo.

if not exist "config.json" (
    copy "config.example.json" "config.json" >nul 2>&1
)

REM -- Installing Windows service ----------------------------------------
echo   Installing Windows Service
echo   ----------------------------------------------------------------
echo.

PowerShell -ExecutionPolicy Bypass -File "scripts\install.ps1"
set INSTALL_RESULT=%errorLevel%

if %INSTALL_RESULT% neq 0 (
    echo.
    echo   +----------------------------------------------------------------+
    echo   ::  Installation did not complete successfully.                  ::
    echo   ::                                                              ::
    echo   ::  Troubleshooting:                                            ::
    echo   ::    1. Ensure you are running as Administrator                ::
    echo   ::    2. Run  scripts\uninstall.bat  to clean up first          ::
    echo   ::    3. Check logs in %%TEMP%%\XPThermalInstall_*.log            ::
    echo   +----------------------------------------------------------------+
    echo.
    pause
    exit /b 1
)

timeout /t 2 /nobreak >nul

REM -- Open dashboard ----------------------------------------------------
for /L %%p in (9100,1,9110) do (
    curl -s -o nul -w "" http://127.0.0.1:%%p/health >nul 2>&1
    if !errorLevel! equ 0 (
        start http://127.0.0.1:%%p/dashboard
        goto :done
    )
)

set "PORT=9100"
if exist "%ProgramData%\XPThermalService\active_port.txt" (
    set /p PORT=<"%ProgramData%\XPThermalService\active_port.txt"
)
start http://127.0.0.1:!PORT!/dashboard

:done
echo.
echo   Opening dashboard in your browser...
echo.
echo   Press any key to close this window.
pause >nul
