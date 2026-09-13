@echo off
setlocal
title mbrd desktop
cd /d "%~dp0"

rem The desktop app, launched from the root. server.bat's opposite number: that
rem one opens the web app in a browser, this one opens the shell.
rem
rem Two modes, and the first is the one to use.
rem
rem   desktop.bat [board]    Build and run from this working copy, and keep the
rem                          web bundle building while the app is open, so a
rem                          saved .ts file shows on Ctrl+R. A .mbrd file dropped
rem                          on this one opens in the app.
rem   desktop.bat portable   Rebuild desktop\portable\ and run that instead.
rem                          This is the packaged application - it carries its
rem                          own frozen copy of web\ - so use it to check what
rem                          ships, not to test a change. It takes minutes.
rem
rem Four things happen before the window appears, each for a reason. The shape
rem is FileAnalyser's desktop.bat.
rem   1. Both packages' dependencies are gitignored, so a fresh clone installs
rem      them here, once.
rem   2. index.html loads assets/app.js, which is a build artefact. Electron reads
rem      web\ live, but "live" means the bundle on disk and not the TypeScript
rem      beside it. So the bundle and the shell are built first, or the window
rem      opens on the last build and an edit looks like it did nothing.
rem   3. Then `npm run dev` watches the web sources INSIDE this console, so the
rem      loop is save and Ctrl+R rather than close and relaunch. It stops when
rem      the app closes.
rem   4. ELECTRON_RUN_AS_NODE is cleared, just below.

rem Electron starts as plain Node when this is set, and then `app` is undefined
rem and the first line of main.ts throws:
rem
rem   TypeError: Cannot read properties of undefined (reading
rem   'requestSingleInstanceLock')
rem
rem Nothing in this repository sets it. An Electron-based editor does - VS Code,
rem Cursor and the rest run their integrated terminal with
rem ELECTRON_RUN_AS_NODE=1 - so the app fails to start in the one terminal a
rem person is most likely to use, and the error names a file they did not touch.
rem `setlocal` at the top keeps this clearing inside the script.
set "ELECTRON_RUN_AS_NODE="

rem Anything else on the command line goes to the app: main.ts opens the .mbrd
rem paths in its argv and ignores the rest.
if /i "%~1"=="portable" goto :portable
if /i "%~1"=="--portable" goto :portable

rem ---------------------------------------------------------------------------
rem The working copy
rem ---------------------------------------------------------------------------

rem `if errorlevel` rather than `||`, which is the form the rest of this
rem repository uses and the only one that reads the same on every shell.
call :install root node_modules .
if errorlevel 1 exit /b 1
call :install shell desktop\node_modules\electron desktop
if errorlevel 1 exit /b 1

echo.
echo   Building the web bundle...
call npm run build
if errorlevel 1 goto :failed

echo   Building the shell...
call npm --prefix desktop run build
if errorlevel 1 goto :failed

rem ---------------------------------------------------------------------------
rem The web watch. `npm run dev` is esbuild --watch writing assets/app.js, so a
rem saved .ts file is in the bundle a moment later and Ctrl+R shows it. HTML and
rem CSS need no watch: the app:// handler reads web\ off the disk on every
rem request. Nothing watches desktop\ itself: a change to the shell needs the
rem window closed and this run again.
rem
rem `start /b`, not `start`: no second console. The watch runs inside this one,
rem so its build errors land here, and it goes when this does: esbuild's watch
rem stops by itself when its stdin closes ("stopped automatically because stdin
rem was closed"). That is also why it cannot be tested from a shell with no
rem console: there it stops at once.
rem
rem A watch already running - `npm run dev` in another terminal - is reused and
rem left alone on the way out, or two watchers would write the same file. One
rem watch is three processes (cmd, node and esbuild.exe), and each command line
rem names esbuild, --watch and assets/app.js. assets/app.js keeps dev:lab and
rem dev:sound, which write other bundles, out of the count. The names keep out
rem the cmd and the powershell that run this very query, whose command lines
rem carry the same three words. Stopping node and esbuild.exe ends the cmd too.
rem
rem .Where() rather than a Where-Object pipe: a bare | would need escaping as ^|
rem inside the for /f below but not in the plain call further down, so one
rem definition could not serve both.
rem ---------------------------------------------------------------------------
set "WATCH_FIND=@(Get-CimInstance Win32_Process).Where({ ($_.Name -eq 'node.exe' -or $_.Name -eq 'esbuild.exe') -and $_.CommandLine -like '*esbuild*' -and $_.CommandLine -like '*--watch*' -and $_.CommandLine -like '*assets/app.js*' })"
set "WATCH_MINE="
set "WATCH_COUNT=0"
for /f %%c in ('powershell -NoProfile -Command "%WATCH_FIND%.Count" 2^>nul') do set "WATCH_COUNT=%%c"

if "%WATCH_COUNT%"=="0" (
  echo.
  echo   Watching the web sources for changes...
  start /b "" cmd /c npm run dev
  set "WATCH_MINE=1"
) else (
  echo.
  echo   A web watch is already running - reusing it.
)

echo.
echo   Starting mbrd. Save a .ts file, then press Ctrl+R in the app.
echo   Log: %APPDATA%\mbrd\logs\main.log
echo.
rem Electron through its npm shim, in the foreground, with %* passed on. In the
rem foreground so this script is still here when the app closes, to stop the
rem watch it started. %* so a board dropped on this file reaches the app.
rem
rem `call` is load-bearing: electron.cmd is itself a batch file, and a batch file
rem invoked without call transfers control instead of returning, which makes
rem every line below here dead.
call desktop\node_modules\.bin\electron.cmd desktop %*
set "MBRD_EXIT=%errorlevel%"

rem The window closed, so the watch goes too, but only one this script started.
rem `start /b` hands back no PID, so it is found the way it was counted. A
rem single-line `if` rather than a block: the PowerShell brackets inside a
rem parenthesised block confuse cmd's parser.
if defined WATCH_MINE powershell -NoProfile -Command "%WATCH_FIND%.ForEach({ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue })" 1>nul 2>nul

rem Only stop on a real failure. A clean quit leaves no console behind.
if not "%MBRD_EXIT%"=="0" (
  echo.
  echo   mbrd exited with an error. Log: %APPDATA%\mbrd\logs\main.log
  pause
)
exit /b %MBRD_EXIT%

rem ---------------------------------------------------------------------------
rem The packaged copy
rem ---------------------------------------------------------------------------

:portable
rem `if errorlevel` rather than `||`, which is the form the rest of this
rem repository uses and the only one that reads the same on every shell.
call :install root node_modules .
if errorlevel 1 exit /b 1
call :install shell desktop\node_modules\electron desktop
if errorlevel 1 exit /b 1

rem The web bundle first here too, and for a sharper reason than above: the
rem packer copies web\ into the package, so a stale bundle is frozen into the
rem thing you are about to test and stays wrong until the next rebuild.
echo.
echo   Building the web bundle...
call npm run build
if errorlevel 1 goto :failed

echo.
echo   Packaging. This takes minutes rather than seconds.
call npm run portable
if errorlevel 1 goto :failed

if not exist "desktop\portable\mbrd.exe" (
  echo.
  echo   The packer reported success but desktop\portable\mbrd.exe is not there.
  goto :failed
)

rem Started detached, unlike the working copy above. This is the installed
rem application rather than a run of a dev script, and holding a console window
rem open behind it for the length of the session would be this launcher
rem pretending to own a process it does not.
echo.
echo   Opening desktop\portable\mbrd.exe
start "" "desktop\portable\mbrd.exe"
exit /b 0

rem ---------------------------------------------------------------------------

rem A package's dependencies, installed when they are missing: %1 names it for
rem the message, %2 is the folder that proves it is installed, %3 is where npm
rem runs. The shell's proof is its electron folder rather than node_modules, so
rem an install that died halfway is tried again.
:install
if exist "%~2\" exit /b 0
echo.
echo   First run - installing the %~1 dependencies. This takes a minute.
echo.
pushd "%~3"
call npm install
popd
if exist "%~2\" exit /b 0
echo.
echo   npm install failed in %~3. Fix that first, then run this again.
pause
exit /b 1

:failed
echo.
echo   Failed. The output above says where.
echo   If the window opened and then died, read %APPDATA%\mbrd\logs\main.log
echo.
pause
exit /b 1
