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

rem The branch that is actually checked out.
rem
rem Everything below used to say "origin main" outright while the menu offered
rem to "push current branch". On any branch but main that combination is a trap:
rem it commits where you are and then pushes something else, and reports success
rem for having done it. Resolved once, here, and used everywhere.
call :resolvebranch

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
call :resolvebranch
echo [git]  initialised. Add a remote later with:
echo        git remote add origin ^<url^>
goto save


:save
echo.
echo === git: save ===
echo.

set SAVE_ERROR=0

rem An unfinished merge must never reach "git add ." below. That command cannot
rem tell a resolved file from one still carrying <<<<<<< markers: it stages the
rem markers and Git records the conflict as settled, so the commit - and the
rem push after it - ships an application that no browser and no test run can
rem parse. Bail before the version stamps are rewritten, so a refused save
rem leaves the tree exactly as it found it.
set UNMERGED=
for /f "delims=" %%u in ('git diff --name-only --diff-filter=U 2^>nul') do set UNMERGED=1
if defined UNMERGED (
  echo [err]  unresolved merge conflicts - resolve these first:
  git diff --name-only --diff-filter=U
  echo.
  echo        fix each file, "git add" it, then rerun this script.
  set SAVE_ERROR=1
  goto end
)

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

rem Rebuild the bundle, and do it HERE - after the two stamps above and before
rem the staging below.
rem
rem index.html loads assets/app.js, wrangler serves ./web as static files, and
rem nothing builds on deploy. So what reaches a visitor is whatever bundle is
rem committed, and until now nothing in this script made one: the artifact was
rem only ever as fresh as the last time somebody happened to run `npm run build`
rem or leave `npm run dev` watching. That failed exactly the way an unenforced
rem step does - v0.187 committed four modules (commands, layout, state,
rem import/drop) written after the bundle beside them was built, so the sources
rem said one thing and the file the browser actually loads said another.
rem
rem After the stamps, because version.js is bundled INTO app.js. Built before
rem them, every release ships a bundle announcing the previous version - which
rem is how v0.187 came to log "v0.156 ready" in the console.
rem
rem A failed build stops the commit rather than warning. A bundle that did not
rem build is not a stale bundle, it is the previous one, and committing it would
rem ship sources that have never once been compiled together.
echo [bld]  bundle
call npm run build
if errorlevel 1 (
  echo.
  echo [err]  the bundle did not build - nothing has been committed.
  echo        run "npm install" if esbuild is missing, then fix the error above.
  set SAVE_ERROR=1
  goto end
)

rem The app is its own 404 page, and a static host wants that spelled as a file:
rem web/404.html is index.html byte for byte, served with a 404 status at every
rem address the app does not have (see wrangler.jsonc). Copied here rather than
rem maintained, because two hand-edited copies of a 60KB document drift the first
rem time only one of them is touched - and the drift is silent, since the copy is
rem the page nobody looks at. Byte copy, not a re-render: tests/notfound.test.js
rem compares them and fails on a single differing byte. Runs after the stamps
rem above so it carries them, though neither of them writes index.html today.
copy /y "web\index.html" "web\404.html" >nul
if errorlevel 1 (
  echo.
  echo [err]  could not refresh web/404.html from web/index.html
  set SAVE_ERROR=1
  goto end
)

rem The changelog, for the same reason and one more. web/patch.html carries the
rem prose from patch-notes.md at the repository root and, around it, index.html's
rem own load block - every stylesheet and the pre-paint look restore - so a
rem change to the shell has to reach it or /patch is dressed by an older cascade
rem than the site is. Reproducible: no timestamps anywhere in it, so re-running
rem with nothing edited writes identical bytes and stages nothing. This run is
rem the only thing keeping the page level with the prose - nothing in the suite
rem checks it.
echo [gen]  patch notes
node tools\gen-patch-page.mjs
if errorlevel 1 (
  echo.
  echo [err]  could not rebuild web/patch.html
  set SAVE_ERROR=1
  goto end
)

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

rem Re-resolved: in a repo whose first commit has just been made, HEAD did not
rem name a branch when this script started.
call :resolvebranch

if "%COMMIT_ONLY%"=="1" goto committed

rem No remote yet is the normal state for a fresh repo - commit and say so
rem rather than failing a push that was never going to work.
if "%REMOTE%"=="" (
  echo.
  echo [git]  committed v%VERLABEL% - no remote configured, nothing pushed
  echo        add one with: git remote add origin ^<url^>
  goto end
)

if "%FORCE_MODE%"=="1" goto forcepush

if "%BRANCH%"=="" goto nobranch
echo.
set /p DOPUSH=push to %REMOTE%/%BRANCH%? (y/n):
if /i not "%DOPUSH%"=="y" goto skipped

git push -u %REMOTE% %BRANCH%
if not errorlevel 1 goto pushed

rem A push can fail for reasons a pull or a force push cannot fix - a 403 from a
rem repo you cannot write to, a bad credential, no network. Only a non-fast-
rem forward (the remote genuinely moved) is worth offering to pull or force. Ask
rem the remote which one this is instead of asserting "remote is ahead" for every
rem failure and then offering remedies that make an auth error look like the
rem user's fault. git ls-remote hits the same endpoint the push just did: if it
rem also fails, the push never got as far as comparing histories.
git ls-remote %REMOTE% >nul 2>nul
if errorlevel 1 (
  echo.
  echo [err]  push failed - cannot reach or authenticate to %REMOTE%
  echo        this is not a "remote is ahead" - a pull or force push will not fix it.
  echo        check access to the remote, then rerun. The commit is saved locally.
  set SAVE_ERROR=1
  goto end
)

echo.
echo [warn] push rejected - remote is ahead of local
echo.
set /p FETCH=pull + merge remote first? (y/n):
if /i "%FETCH%"=="y" goto fetch

echo.
echo [warn] a force push discards whatever is on %REMOTE%/%BRANCH% that you do
echo        not have. If anyone else has pushed, their work goes with it.
set /p FORCE=force push instead? (y/n):
if /i "%FORCE%"=="y" goto forcepush

echo [git]  skipped - nothing pushed
set SAVE_ERROR=1
goto end

:fetch
git pull %REMOTE% %BRANCH%
if errorlevel 1 set SAVE_ERROR=1
echo.
echo [git]  pulled - resolve any conflicts, then re-run
goto end

:forcepush
if "%BRANCH%"=="" goto nobranch
rem --force-with-lease, not --force: it refuses when the remote has moved since
rem the last fetch, which is the one case a force push is actually destructive.
git push %REMOTE% %BRANCH% --force-with-lease
if errorlevel 1 set SAVE_ERROR=1
echo.
echo [git]  force pushed %REMOTE%/%BRANCH%
goto end

:pushed
echo.
echo [git]  pushed %REMOTE%/%BRANCH%
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
if "%BRANCH%"=="" goto nobranch
if "%REMOTE%"=="" goto noremote
git push %REMOTE% %BRANCH%
if errorlevel 1 (
  echo.
  echo [warn] a force push discards whatever is on %REMOTE%/%BRANCH% that you do
  echo        not have. If anyone else has pushed, their work goes with it.
  set /p FORCE=push failed. force push? (y/n):
  if /i "!FORCE!"=="y" (
    git push %REMOTE% %BRANCH% --force-with-lease
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
if "%BRANCH%"=="" goto nobranch
if "%REMOTE%"=="" goto noremote
git pull %REMOTE% %BRANCH%
if errorlevel 1 set SAVE_ERROR=1
goto end


rem Resolve the checked-out branch into %BRANCH%. Empty when there is no repo
rem yet (the first save offers to create one) or when HEAD is detached, which
rem is not a state to push from.
:resolvebranch
set BRANCH=
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
if /i "%BRANCH%"=="HEAD" set BRANCH=
call :resolveremote
exit /b 0

rem Resolve the remote to push/pull against into %REMOTE%. This used to be the
rem literal "origin" everywhere, which silently did nothing on a repo whose only
rem remote is named something else (this one's is "mbrd") - the push check found
rem no "origin" and reported success for having pushed nothing. Prefer the
rem branch's own upstream remote, fall back to origin, then to the first remote
rem defined. Empty only when the repo has no remotes at all.
:resolveremote
set REMOTE=
if not "%BRANCH%"=="" for /f "delims=" %%r in ('git config branch.%BRANCH%.remote 2^>nul') do set REMOTE=%%r
if not "%REMOTE%"=="" exit /b 0
git remote get-url origin >nul 2>nul
if not errorlevel 1 (set REMOTE=origin & exit /b 0)
for /f "delims=" %%r in ('git remote 2^>nul') do if "!REMOTE!"=="" set REMOTE=%%r
exit /b 0

:nobranch
echo.
echo [err]  no branch checked out (detached HEAD?) - not pushing
set SAVE_ERROR=1
goto end

:noremote
echo.
echo [err]  no remote configured - add one with: git remote add origin ^<url^>
set SAVE_ERROR=1
goto end


:end
echo.
pause
exit /b %SAVE_ERROR%
