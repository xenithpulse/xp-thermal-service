@echo off
REM XP Thermal Service - Uninstall Batch Wrapper
REM Run as Administrator

echo.
echo ========================================
echo   XP Thermal Service Uninstaller
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

REM Run PowerShell uninstaller
PowerShell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall

if %errorLevel% equ 0 (
    echo.
    echo Uninstallation completed successfully!
) else (
    echo.
    echo Uninstallation failed. See errors above.
)

echo.
pause
