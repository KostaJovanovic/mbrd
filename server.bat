@echo off
title mbrd server
cd /d "%~dp0"

rem 6273 is "mbrd" on a phone keypad. Deliberately off the well-worn ports
rem (3000, 5173, 8000, 8080) so this never fights another project for one.
set PORT=6273

rem Free the port so every launch is a fresh instance - but only from a process
rem that is recognisably a previous run of this script. It used to stop whatever
rem was listening, full stop, which on a port collision meant force-killing
rem somebody else's editor, database or dev server with no warning and no way to
rem tell what had happened. A launcher may clean up after itself; it may not
rem clean up after other people.
rem
rem The test is "a python process whose command line mentions this repo's
rem serve.py". Anything else is reported and left alone, and the server below
rem then fails to bind and says so.
powershell -NoProfile -Command ^
  "$mine = '%~dp0serve.py'.Replace('\\','\');" ^
  "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue |" ^
  "  Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 } | ForEach-Object {" ^
  "    $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $_\" -ErrorAction SilentlyContinue;" ^
  "    if ($p -and $p.CommandLine -and $p.CommandLine.Replace('/','\') -like ('*' + $mine + '*')) {" ^
  "      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue" ^
  "    } elseif ($p) {" ^
  "      Write-Host ('Port %PORT% is held by PID ' + $p.ProcessId + ': ' + $p.Name) -ForegroundColor Yellow;" ^
  "      Write-Host ('  ' + $p.CommandLine) -ForegroundColor DarkGray;" ^
  "      Write-Host '  Not this project''s server - leaving it alone.' -ForegroundColor Yellow" ^
  "    }" ^
  "  }"

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
rem serve.py serves web/, answers an unknown address with index.html under a 404
rem status (the app is its own 404 page), and prints a scannable QR for the
rem Network URL at startup (LOCAL_IP passed in so it doesn't have to guess).
python serve.py %PORT% %LOCAL_IP%
pause
