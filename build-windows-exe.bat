@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   Relay - Windows (.exe) Auto Builder
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Please install Node.js LTS from https://nodejs.org/ and run this file again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH.
    pause
    exit /b 1
)

echo [1/4] Installing app dependencies...
call npm install --no-audit --no-fund --legacy-peer-deps
if errorlevel 1 goto :error

if not exist "node_modules\electron\package.json" (
    echo [2/4] Installing Electron and Electron Builder...
    call npm install --no-save --no-audit --no-fund --legacy-peer-deps -D electron electron-builder
    if errorlevel 1 goto :error
) else (
    echo [2/4] Electron tools already installed.
)

if not exist "build\icon.ico" (
    echo Generating app logo...
    call node scripts/generate-icons.mjs
    if errorlevel 1 goto :error
)

echo [3/4] Building web bundle...
call npm run build
if errorlevel 1 goto :error

echo [4/4] Packaging Windows .exe...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win
if errorlevel 1 goto :error

echo.
echo ==========================================
echo   Done! Check the "release" folder for:
echo   - Relay Setup 1.0.0.exe (installer)
echo   - Relay 1.0.0.exe (portable)
echo ==========================================
if exist "release" start "" "release"
pause
exit /b 0

:error
echo.
echo [ERROR] Build failed. See messages above.
pause
exit /b 1
