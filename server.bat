@echo off
title mbrd server
cd /d "%~dp0"

rem 6273 is "mbrd" on a phone keypad. Deliberately off the well-worn ports
rem (3000, 5173, 8000, 8080) so this never fights another project for one -
rem and note that the kill below is unconditional, so a shared port would
rem take somebody else's server down with it.
set PORT=6273

rem Kill whatever is still holding the port so every launch is a fresh instance
rem (a previous server.bat, or any other listener on %PORT%). Uses PowerShell so
rem it handles both IPv4 and IPv6 listeners without brittle netstat parsing.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" 1>nul 2>nul

rem Find local IP for phone access
set LOCAL_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined LOCAL_IP (
    for /f "tokens=* delims= " %%b in ("%%a") do set "LOCAL_IP=%%b"
  )
)

echo.
echo ============================================
echo   Local:   http://localhost:%PORT%
echo   Network: http://%LOCAL_IP%:%PORT%
echo.
echo   Scan the QR below to open it on your phone.
echo   Phone must be on the same Wi-Fi.
echo ============================================
echo.

start "" "http://localhost:%PORT%"
rem serve.py serves web/ with an SPA fallback and prints a scannable QR for the
rem Network URL at startup (LOCAL_IP passed in so it doesn't have to guess).
python serve.py %PORT% %LOCAL_IP%
pause
