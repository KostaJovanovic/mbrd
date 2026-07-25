@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Git helper. Bumps a version stamp on every commit and writes it into two
rem places that must never drift: the VERSION constant the app shows, and the
rem service-worker cache epoch (without that bump, stale-while-revalidate keeps
rem serving the old shell to anyone who already loaded the app).

set FORCE_MODE=0
set COMMIT_ONLY=0
set ACTION=%~1

if /i "%ACTION%"=="--force"   (set FORCE_MODE=1 & set ACTION=save)
if /i "%ACTION%"=="commit"    (set COMMIT_ONLY=1 & set ACTION=save)
if /i "%ACTION%"=="--commit"  (set COMMIT_ONLY=1 & set ACTION=save)
if /i "%ACTION%"=="--no-push" (set COMMIT_ONLY=1 & set ACTION=save)
if /i "%ACTION%"=="save"   goto checkrepo
if /i "%ACTION%"=="push"    goto push
if /i "%ACTION%"=="pull"    goto pull

:menu
echo.
echo === git ===
echo.
echo   1  save     add + commit + push
echo   2  commit   add + commit, no push
echo   3  push     push current branch
echo   4  pull     pull current branch
echo   5  quit
echo.
set /p CHOICE=select [1-5]:
if "%CHOICE%"=="1" goto checkrepo
if "%CHOICE%"=="2" (set COMMIT_ONLY=1 & goto checkrepo)
if "%CHOICE%"=="3" goto push
if "%CHOICE%"=="4" goto pull
if "%CHOICE%"=="5" exit /b 0
echo [err]  invalid choice
goto menu


rem The repo starts life uninitialised, so the first save offers to create it
rem instead of failing with a wall of git errors.
:checkrepo
if exist ".git" goto save
echo.
echo [warn] no git repository here yet
set /p DOINIT=run "git init" now? (y/n):
if /i not "%DOINIT%"=="y" (
  echo [git]  skipped - nothing to commit into
  set SAVE_ERROR=1
  goto end
)
git init -b main
if errorlevel 1 (
  echo [err]  git init failed
  set SAVE_ERROR=1
  goto end
)
echo [git]  initialised. Add a remote later with:
echo        git remote add origin ^<url^>
goto save


:save
echo.
echo === git: save ===
echo.

set SAVE_ERROR=0

for /f %%i in ('git rev-list --count HEAD 2^>nul') do set COMMIT_COUNT=%%i
if not defined COMMIT_COUNT set COMMIT_COUNT=0
set /a NEXT_COUNT=%COMMIT_COUNT%+1

rem Version label mirrors versionLabel() in web/assets/js/version.js. RELEASES is
rem the list of commits crowned as major releases - keep it in sync with
rem RELEASE_COMMITS there (sorted ascending). Each release reads X.0 and resets
rem the minor counter. Empty until the first release is declared.
set RELEASES=
for /f %%v in ('powershell -NoProfile -Command "$n=%NEXT_COUNT%; $major=0; $base=0; foreach($r in @(%RELEASES%)){ if($n -ge $r){ $major++; $base=$r } else { break } }; if($major -eq 0){ '0.{0:D2}' -f $n } elseif(($n-$base) -eq 0){ '{0}.0' -f $major } else { '{0}.{1:D2}' -f $major,($n-$base) }"') do set VERLABEL=%%v
echo bump: v%VERLABEL% (commit %NEXT_COUNT%)

rem -Encoding UTF8 on BOTH ends is required: without it Get-Content reads these
rem UTF-8 files as the ANSI code page and mangles every non-ASCII character a
rem little more on each commit. \d* (not \d+) so a previously-blanked value still
rem matches and self-heals.
powershell -NoProfile -Command "(Get-Content 'web/assets/js/version.js' -Encoding UTF8) -replace 'const COMMIT_COUNT = \d*;', 'const COMMIT_COUNT = %NEXT_COUNT%;' -replace 'const VERSION = ''[^'']*'';', 'const VERSION = ''%VERLABEL%'';' | Set-Content 'web/assets/js/version.js' -Encoding utf8"

rem Bump the service-worker cache epoch, so every commit ships fresh JS/CSS
rem instead of leaving already-installed clients on a stale shell.
powershell -NoProfile -Command "(Get-Content 'web/sw.js' -Encoding UTF8) -replace 'const VERSION = ''mbrd-v\d*'';', 'const VERSION = ''mbrd-v%NEXT_COUNT%'';' | Set-Content 'web/sw.js' -Encoding utf8"

echo [git]  stage
git add .
git status

echo.
set /p MSG=commit message [v%VERLABEL%]:
if "%MSG%"=="" set MSG=v%VERLABEL%

git commit -m "%MSG%"
if errorlevel 1 (
  echo.
  echo [err]  git commit failed
  set SAVE_ERROR=1
  goto end
)

if "%COMMIT_ONLY%"=="1" goto committed

rem No remote yet is the normal state for a fresh repo - commit and say so
rem rather than failing a push that was never going to work.
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo.
  echo [git]  committed v%VERLABEL% - no 'origin' remote, nothing pushed
  echo        add one with: git remote add origin ^<url^>
  goto end
)

if "%FORCE_MODE%"=="1" goto forcepush

echo.
set /p DOPUSH=push to origin/main? (y/n):
if /i not "%DOPUSH%"=="y" goto skipped

git push -u origin main
if not errorlevel 1 goto pushed

echo.
echo [warn] push rejected - remote is ahead of local
echo.
set /p FETCH=pull + merge remote first? (y/n):
if /i "%FETCH%"=="y" goto fetch

set /p FORCE=force push instead? overwrites the remote. (y/n):
if /i "%FORCE%"=="y" goto forcepush

echo [git]  skipped - nothing pushed
set SAVE_ERROR=1
goto end

:fetch
git pull origin main
if errorlevel 1 set SAVE_ERROR=1
echo.
echo [git]  pulled - resolve any conflicts, then re-run
goto end

:forcepush
git push origin main --force
if errorlevel 1 set SAVE_ERROR=1
echo.
echo [git]  force pushed origin/main
goto end

:pushed
echo.
echo [git]  pushed origin/main
goto end

:skipped
echo.
echo [git]  push skipped
goto end

:committed
echo.
echo [git]  committed v%VERLABEL% (local, not pushed)
goto end


:push
echo.
echo === git: push ===
echo.
set SAVE_ERROR=0
git push origin main
if errorlevel 1 (
  echo.
  set /p FORCE=push failed. force push? overwrites the remote. (y/n):
  if /i "!FORCE!"=="y" (
    git push origin main --force
    if errorlevel 1 set SAVE_ERROR=1
  ) else (
    set SAVE_ERROR=1
  )
)
goto end


:pull
echo.
echo === git: pull ===
echo.
set SAVE_ERROR=0
git pull origin main
if errorlevel 1 set SAVE_ERROR=1
goto end


:end
echo.
pause
exit /b %SAVE_ERROR%
