@echo off
setlocal EnableDelayedExpansion
REM ============================================
REM   XP Thermal Service - One-Click Setup
REM   Powered by XenithPulse.com
REM ============================================
REM
REM   Double-click this file to install.
REM   It will:
REM     1. Check for Node.js
REM     2. Install dependencies
REM     3. Build the service
REM     4. Register as a Windows service (auto-start)
REM     5. Open the configuration dashboard
REM
REM   Requires: Administrator privileges
REM ============================================

echo.
echo   =========================================
echo    XP Thermal Service - Setup
echo    Powered by XenithPulse.com
echo   =========================================
echo.

REM Check admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo   [!] Administrator privileges required.
    echo       Right-click this file and choose
    echo       "Run as administrator"
    echo.
    pause
    exit /b 1
)

REM Navigate to project root (where this bat lives)
cd /d "%~dp0"

REM Step 1: Check Node.js
echo   [1/5] Checking Node.js...
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo   [!] Node.js is not installed.
    echo       Download and install Node.js 18+ from:
    echo       https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo         Found Node.js %%i

REM Step 2: Install dependencies
echo   [2/5] Installing dependencies...
call npm install >nul 2>&1
if %errorLevel% neq 0 (
    echo   [!] npm install failed. Check your network connection.
    pause
    exit /b 1
)
echo         Done.

REM Step 3: Build
echo   [3/5] Building service...
call npm run build >nul 2>&1
if %errorLevel% neq 0 (
    echo   [!] Build failed. Check for TypeScript errors.
    pause
    exit /b 1
)
echo         Done.

REM Step 4: Create default config if missing
if not exist "config.json" (
    echo   [*] Creating default config.json...
    copy "config.example.json" "config.json" >nul 2>&1
)

REM Step 5: Install as Windows service
echo   [4/5] Installing Windows service...
echo.
PowerShell -ExecutionPolicy Bypass -File "scripts\install.ps1"

set INSTALL_RESULT=%errorLevel%

REM Step 6: Done - open dashboard
echo.
echo   [5/5] Setup complete!
echo.

if %INSTALL_RESULT% neq 0 (
    echo   =========================================
    echo    Installation had issues
    echo   =========================================
    echo.
    echo   The service installation encountered problems.
    echo   Please check the logs above for details.
    echo.
    echo   You can try:
    echo     1. Run as Administrator
    echo     2. Run scripts\uninstall.bat first
    echo     3. Check the installation log in %%TEMP%%
    echo.
) else (
    echo   =========================================
    echo    XP Thermal Service is now installed!
    echo   =========================================
    echo.
    
    REM Try to read actual port from install location
    set "DASHBOARD_PORT=9100"
    if exist "%ProgramData%\XPThermalService\active_port.txt" (
        set /p DASHBOARD_PORT=<"%ProgramData%\XPThermalService\active_port.txt"
    )
    
    echo   Dashboard:  http://127.0.0.1:!DASHBOARD_PORT!/dashboard
    echo   API:        http://127.0.0.1:!DASHBOARD_PORT!/health
    echo.
    echo   The service will:
    echo     - Start automatically on boot
    echo     - Auto-restart if it crashes
    echo     - Be monitored by a watchdog
    echo.
    echo   Opening dashboard in your browser...
    echo.
    
    timeout /t 3 >nul
    
    REM Try each possible port
    for /L %%p in (9100,1,9110) do (
        curl -s -o nul -w "" http://127.0.0.1:%%p/health >nul 2>&1
        if !errorLevel! equ 0 (
            start http://127.0.0.1:%%p/dashboard
            goto :done
        )
    )
    REM Fallback
    start http://127.0.0.1:9100/dashboard
)

:done
pause
