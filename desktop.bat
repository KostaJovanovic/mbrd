@echo off
setlocal
title mbrd desktop
cd /d "%~dp0"

rem The desktop app, launched from the root. server.bat's opposite number: that
rem one opens the web app in a browser, this one opens the shell.
rem
rem Two modes, and the first is the one to use.
rem
rem   desktop.bat            Rebuild and run from this working copy. Electron
rem                          serves web\ off the disk you are editing, so what
rem                          opens is the code you just wrote.
rem   desktop.bat portable   Rebuild desktop\portable\ and run that instead.
rem                          This is the packaged application - it carries its
rem                          own frozen copy of web\ - so use it to check what
rem                          ships, not to test a change. It takes minutes.
rem
rem ── Why this rebuilds the web bundle first ──
rem
rem index.html loads assets/app.js, which is a build artefact. Electron reads
rem web\ live, but "live" means the *bundle* on disk and not the TypeScript
rem beside it. Without the build below, an edit to a .ts file opens the previous
rem build and looks like a change that did nothing. That failure is silent, it
rem costs an afternoon, and one second of esbuild prevents it.
rem
rem ── The console goes when the app opens ──
rem
rem The builds run in this window and the app does not. See the note over the
rem `start` line below for how, and for why `npm run desktop` cannot do it.
rem
rem ── Ctrl+R reloads, but nothing rebuilds ──
rem
rem The window reads web\ off the disk fresh on every request, so Ctrl+R shows
rem the last build. It does not run one. To edit a .ts file and see it, keep
rem `npm run dev` in another terminal and press Ctrl+R - or close the window and
rem run this again, which is about three seconds all in.

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

if /i "%~1"=="portable" goto :portable
if /i "%~1"=="--portable" goto :portable
if not "%~1"=="" (
  echo Unknown argument: %~1
  echo Usage: desktop.bat [portable]
  exit /b 2
)

rem ---------------------------------------------------------------------------
rem The working copy
rem ---------------------------------------------------------------------------

rem `if errorlevel` rather than `||`, which is the form the rest of this
rem repository uses and the only one that reads the same on every shell.
call :needs root node_modules "npm install"
if errorlevel 1 exit /b 1
call :needs shell desktop\node_modules "cd desktop && npm install"
if errorlevel 1 exit /b 1

echo.
echo   Building the web bundle...
call npm run build
if errorlevel 1 goto :failed

echo   Building the shell...
call npm --prefix desktop run build
if errorlevel 1 goto :failed

rem Electron's own binary, started detached, and this is why the console is not
rem here a moment from now.
rem
rem `npm run desktop` is the same two builds and then `electron .`, all of it in
rem the foreground - so cmd has to stay alive for as long as the app does, and
rem the app opens with a black console window sitting behind it. Nothing needs
rem that window: the builds have already run and said what they had to say, and
rem the shell writes what happens next to its own log.
rem
rem So the builds keep the console, and the app does not get one. `start`
rem launches a process this script does not wait for, electron.exe is a GUI
rem binary and allocates no console of its own, and the `exit /b` below closes
rem what is left. The app outlives it - a started process is not a child cmd
rem takes with it.
rem
rem The binary rather than the npm script, because the npm script is a Node shim
rem and a shim is a console program: starting *that* detached would put the
rem window back, one process further away.
set "ELECTRON=desktop\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo.
  echo   %ELECTRON% is missing, so this falls back to npm.
  echo   The app will open with a console window behind it.
  echo.
  call npm run desktop
  if errorlevel 1 goto :failed
  exit /b 0
)

rem The app directory as an argument, which is what `electron .` passes too.
rem Everything the shell resolves hangs off app.getAppPath() rather than the
rem working directory - see webRoot() in desktop\protocol.ts - so the two ways
rem in are the same way in.
echo.
echo   Opening. Log: %APPDATA%\mbrd\logs\main.log
start "" "%ELECTRON%" "%~dp0desktop"
exit /b 0

rem ---------------------------------------------------------------------------
rem The packaged copy
rem ---------------------------------------------------------------------------

:portable
rem `if errorlevel` rather than `||`, which is the form the rest of this
rem repository uses and the only one that reads the same on every shell.
call :needs root node_modules "npm install"
if errorlevel 1 exit /b 1
call :needs shell desktop\node_modules "cd desktop && npm install"
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

rem A missing node_modules, reported as the command that fixes it.
rem
rem Both are worth checking by hand rather than leaving npm to complain. The
rem shell's install pulls Electron, which is hundreds of megabytes, and a
rem launcher that starts that download because somebody double-clicked a file is
rem a launcher nobody trusts. So it says what to run and stops.
:needs
if exist "%~2\" exit /b 0
echo.
echo   The %~1 dependencies are not installed: %~2 is missing.
echo   Run this first:
echo.
echo       %~3
echo.
pause
exit /b 1

:failed
echo.
echo   Failed. The output above says where.
echo   If the window opened and then died, read %APPDATA%\mbrd\logs\main.log
echo.
pause
exit /b 1
