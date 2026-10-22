@echo off
REM XP Thermal Service - Installation Batch Wrapper
REM Run as Administrator

echo.
echo ========================================
echo   XP Thermal Service Installer
echo ========================================
echo.

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Right-click and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

REM Run PowerShell installer
PowerShell -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*

if %errorLevel% equ 0 (
    echo.
    echo Installation completed successfully!
) else (
    echo.
    echo Installation failed. See errors above.
)

echo.
pause
