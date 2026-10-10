@echo off
rem The second argument is copied out before delayed expansion is switched on,
rem and only ever read back as !ARG2!. It is the commit message in `quick` mode,
rem and a message is free text: with delayed expansion on, the copy itself would
rem eat every "!" in it, and a stray double quote in a message pasted straight
rem into an `if "..."` line is a syntax error that kills the script mid-save.
rem A delayed-expansion read is not re-parsed, so neither can happen after this.
setlocal disabledelayedexpansion
set "ARG2=%~2"
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Git helper. Bumps a version stamp on every commit and writes it into two
rem places that must never drift: the VERSION constant the app shows, and the
rem service-worker cache epoch (without that bump, stale-while-revalidate keeps
rem serving the old shell to anyone who already loaded the app).
rem
rem Three things are rebuilt before the commit, and each is argued where it
rem happens: the bundle, web/404.html and web/patch.html. All three are
rem committed, and a stale one ships. The portable copy in desktop\portable\ is
rem not part of a save. It has its own menu option, `portable` (:portableonly).
rem
rem With no argument it shows the menu. The arguments it takes instead:
rem
rem   save.bat save                    add + commit, then ask before pushing
rem   save.bat commit                  add + commit, no push
rem   save.bat release [all]           add + commit + push, then start a release
rem   save.bat push / pull / portable  what the menu options of the same name do
rem   save.bat quick "message"         add + commit + push, and never ask anything
rem   save.bat quick-commit "message"  add + commit, and never ask anything
rem   save.bat crown "message"         the same, and the commit is the next X.0
rem
rem The two quick actions are the save above with nobody at the keyboard: an
rem editor, an agent, a Git Bash one-liner (cmd //c "save.bat quick \"msg\"").
rem They run every step a save runs - the stamps, the bundle, 404.html,
rem patch.html - and the difference is only in who answers. There is no
rem menu, no prompt and no closing pause, and every question on the way gets
rem the answer that loses nothing: no `git init`, no pull, no force push. A
rem refusal is a non-zero exit, and so is a push that did not happen, whether
rem the remote refused it, could not be reached or does not exist. The commit
rem is kept locally in every one of those cases. An empty message falls back to
rem the prompt's own default, v<version>. QUICK is a flag on the one save
rem routine rather than a second copy of it, because two copies of a routine
rem this long disagree the first time only one of them is fixed.

set FORCE_MODE=0
set COMMIT_ONLY=0
set RELEASE_MODE=0
set "QUICK=0"
set "CROWN=0"
rem Which systems a release builds, passed to the workflow as `systems`. Two by
rem default, because those are the two this machine runs and a macOS minute
rem bills at ten times a Linux one. `save.bat release all` and menu option 7
rem ask for all four. The workflow's own default is `all`, and deliberately
rem disagrees with this one: there it is only reached by a hand-started run
rem from the Actions tab, where an incomplete release costs more than minutes.
set "RELEASE_SYSTEMS=windows-android"
set ACTION=%~1

rem The branch that is actually checked out.
rem
rem Everything below used to say "origin main" outright while the menu offered
rem to "push current branch". On any branch but main that combination is a trap:
rem it commits where you are and then pushes something else, and reports success
rem for having done it. Resolved once, here, and used everywhere.
call :resolvebranch

rem set "VAR=value" and not set VAR=value, and this is not a style choice.
rem
rem Inside parentheses, `set FORCE_MODE=1 & set ACTION=save` assigns everything
rem up to the `&` - including the space in front of it. FORCE_MODE becomes "1 ",
rem every `if "%FORCE_MODE%"=="1"` below compares unequal, and the flag silently
rem does nothing. All four of these lines had it, and so did the menu: `save.bat
rem commit` set COMMIT_ONLY and then asked to push anyway, because the answer to
rem "is this commit-only" was a string that only looked like 1. The quoted form
rem ends the value at the closing quote and is immune to it.
if /i "%ACTION%"=="--force"   (set "FORCE_MODE=1" & set "ACTION=save")
if /i "%ACTION%"=="commit"    (set "COMMIT_ONLY=1" & set "ACTION=save")
if /i "%ACTION%"=="--commit"  (set "COMMIT_ONLY=1" & set "ACTION=save")
if /i "%ACTION%"=="--no-push" (set "COMMIT_ONLY=1" & set "ACTION=save")
if /i "%ACTION%"=="quick"        (set "QUICK=1" & set "ACTION=save")
if /i "%ACTION%"=="quick-commit" (set "QUICK=1" & set "COMMIT_ONLY=1" & set "ACTION=save")
rem A crown is a quick-commit that also makes this commit the next X.0.
if /i "%ACTION%"=="crown"        (set "CROWN=1" & set "QUICK=1" & set "COMMIT_ONLY=1" & set "ACTION=save")
rem `save.bat release` builds the two; `save.bat release all` builds all four.
rem The second argument is read as !ARG2! (see the top of the file), because
rem this line is parsed on every run, and in `quick` mode that argument is a
rem commit message whose quotes would otherwise land inside this `if`.
if /i "%ACTION%"=="release"   (set "RELEASE_MODE=1" & set "ACTION=save")
if "%RELEASE_MODE%"=="1" if /i "!ARG2!"=="all" (set "RELEASE_SYSTEMS=all")
if /i "%ACTION%"=="save"   goto checkrepo
if /i "%ACTION%"=="push"    goto push
if /i "%ACTION%"=="pull"    goto pull
if /i "%ACTION%"=="portable" goto portableonly

:menu
echo.
echo === git ===
echo.
echo   1  commit      add + commit, no push
echo   2  save        add + commit + push
echo   3  release     add + commit + push, then build Windows and Android
echo   4  pull        pull current branch
echo   5  push        push current branch
echo   6  portable    build desktop\portable\, no commit
echo   7  release-all the same as 3, with macOS and Linux as well
echo   8  quit
echo.
set /p CHOICE=select [1-8]:
rem Quoted, for the reason the lines above the menu give.
rem
rem 3 and 7 differ by one workflow input. A macOS minute bills at ten times a
rem Linux one and a Windows minute at twice, so the two systems that are not
rem run here cost more than the two that are: 3 starts no macOS or Linux
rem runner at all. The release it publishes carries two files and says so, and
rem a macOS or Linux copy sees a version it cannot download until the next 7.
if "%CHOICE%"=="1" (set "COMMIT_ONLY=1" & goto checkrepo)
if "%CHOICE%"=="2" goto checkrepo
if "%CHOICE%"=="3" (set "RELEASE_MODE=1" & goto checkrepo)
if "%CHOICE%"=="4" goto pull
if "%CHOICE%"=="5" goto push
if "%CHOICE%"=="6" goto portableonly
if "%CHOICE%"=="7" (set "RELEASE_MODE=1" & set "RELEASE_SYSTEMS=all" & goto checkrepo)
if "%CHOICE%"=="8" exit /b 0
echo [err]  invalid choice
goto menu


rem The repo starts life uninitialised, so the first save offers to create it
rem instead of failing with a wall of git errors.
:checkrepo
if exist ".git" goto save
echo.
echo [warn] no git repository here yet
rem Creating a repository is not something to do on nobody's say-so.
if "%QUICK%"=="1" (
  echo [err]  quick mode does not run "git init" - run save.bat once by hand
  set "SAVE_ERROR=1"
  goto end
)
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

rem The counter is the project's, not this clone's. It used to be
rem `git rev-list --count HEAD`, which is a property of the local history: a
rem squash, a fresh init or a shallow clone collapses it. FileAnalyser lost its
rem version that way - rev-list returned 1 and 8.14 became 0.02. The Android
rem app makes it worse: its versionCode is this number, and Android refuses an
rem update whose versionCode does not grow, so a count that falls strands every
rem installed copy.
rem
rem So read the committed value out of version.js, which every clone shares,
rem and ABORT when it cannot be read. This runs before either stamp below, so a
rem refused save leaves the tree as it found it.
set COMMIT_COUNT=
for /f %%i in ('powershell -NoProfile -Command "$m=[regex]::Match((Get-Content 'web/assets/js/version.js' -Raw -Encoding UTF8),'export const COMMIT_COUNT = (\d+);'); if($m.Success){$m.Groups[1].Value}"') do set COMMIT_COUNT=%%i
if not defined COMMIT_COUNT goto countfail
set /a NEXT_COUNT=%COMMIT_COUNT%+1
if %NEXT_COUNT% LEQ %COMMIT_COUNT% goto countfail

rem A commit made without this script (a plain `git commit`) stamps nothing, so
rem the file alone falls behind the history: two did on 2026-09-13, and the
rem label read 313 at commit 315. So the history counts too, but only upward:
rem the larger of the two wins, and a count that collapsed is simply outvoted.
set GIT_COUNT=0
for /f %%i in ('git rev-list --count HEAD 2^>nul') do set GIT_COUNT=%%i
set /a GIT_NEXT=%GIT_COUNT%+1
if %GIT_NEXT% GTR %NEXT_COUNT% set NEXT_COUNT=%GIT_NEXT%

rem Keep the two files as they are before the stamps, so that every error exit
rem between here and the commit puts them back (:unstamp). A stamp left behind
rem is read as the committed count on the next run, so each failed save used to
rem skip a version number. A copy and not `git checkout --`: an edit to sw.js
rem that is not committed yet must survive a failed build.
set "STAMP_VERSION=%TEMP%\mbrd-save-version.js"
set "STAMP_SW=%TEMP%\mbrd-save-sw.js"
copy /y "web\assets\js\version.js" "%STAMP_VERSION%" >nul
if errorlevel 1 goto stampkeepfail
copy /y "web\sw.js" "%STAMP_SW%" >nul
if errorlevel 1 goto stampkeepfail

rem `crown`: this commit becomes the next major release, X.0. Its count is
rem appended to RELEASE_COMMITS in version.js, which is the only list of
rem crowned commits there is - the label below is read from it. After the
rem copies above, so a save that fails from here puts the list back too.
if "%CROWN%"=="1" (
  powershell -NoProfile -Command "$p='web/assets/js/version.js'; $s=[IO.File]::ReadAllText($p); $m=[regex]::Match($s,'export const RELEASE_COMMITS = \[([\d, ]*)\];'); if(-not $m.Success){ exit 1 }; $l=@($m.Groups[1].Value -split ',\s*' | Where-Object { $_ }); if($l.Count -and [int]$l[-1] -ge %NEXT_COUNT%){ exit 1 }; $l+='%NEXT_COUNT%'; [IO.File]::WriteAllText($p, $s.Replace($m.Value, 'export const RELEASE_COMMITS = [' + ($l -join ', ') + '];'))"
  if errorlevel 1 (
    echo.
    echo [err]  no RELEASE_COMMITS line in web/assets/js/version.js, or this commit is not past
    echo        the last one crowned - nothing crowned, nothing committed
    call :unstamp
    set SAVE_ERROR=1
    goto end
  )
)

rem The label is versionLabel() in version.js itself, asked through node, so
rem there is one rule for it and not a PowerShell copy that has to agree.
set VERLABEL=
for /f "delims=" %%v in ('node --input-type=module -e "import { versionLabel } from './web/assets/js/version.js'; console.log(versionLabel(%NEXT_COUNT%))"') do set VERLABEL=%%v
if not defined VERLABEL (
  echo.
  echo [err]  could not read the version label from web/assets/js/version.js - is node installed?
  call :unstamp
  set SAVE_ERROR=1
  goto end
)
echo bump: v%VERLABEL% (commit %NEXT_COUNT%)
if "%CROWN%"=="1" echo [ver]  crowned: commit %NEXT_COUNT% is v%VERLABEL%

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
  call :unstamp
  set SAVE_ERROR=1
  goto end
)

rem The app is its own 404 page, and a static host wants that spelled as a file:
rem web/404.html is index.html byte for byte, served with a 404 status at every
rem address the app does not have (see wrangler.jsonc). Copied here rather than
rem maintained, because two hand-edited copies of a 60KB document drift the first
rem time only one of them is touched - and the drift is silent, since the copy is
rem the page nobody looks at. Byte copy, not a re-render: tests/notfound.test.js
rem compares them and fails on a single differing byte. The same tool writes the
rem stylesheets index.html links into SHELL in web/sw.js. Runs after the stamps
rem above so it carries them, though neither of them writes index.html today.
node tools\gen-shell.mjs
if errorlevel 1 (
  echo.
  echo [err]  could not refresh web/404.html and SHELL from web/index.html
  call :unstamp
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
  call :unstamp
  set SAVE_ERROR=1
  goto end
)

echo [git]  stage
git add .
git status

echo.
rem The message never goes through a command line. This script runs with
rem delayed expansion on, so `git commit -m "%MSG%"` lost every "!" in the
rem message, and a double quote in it broke the `if` that read it. set /p stores
rem the text as typed, PowerShell reads it from the environment and writes it
rem as UTF-8, and git reads that file. Cleared first, because set /p leaves the
rem old value in place when the answer is empty. In quick mode the message is
rem the second argument, read back by delayed expansion, which does not
rem re-parse what it substitutes: its "!" and quotes arrive as typed.
set "MSG="
if "%QUICK%"=="1" set "MSG=!ARG2!"
if not "%QUICK%"=="1" set /p "MSG=commit message [v%VERLABEL%]: "
if not defined MSG set "MSG=v%VERLABEL%"
set "MSGFILE=%TEMP%\mbrd-save-message.txt"
powershell -NoProfile -Command "[IO.File]::WriteAllText($env:MSGFILE, $env:MSG)"
if errorlevel 1 (
  echo.
  echo [err]  could not write the commit message to %MSGFILE%
  call :unstamp
  set SAVE_ERROR=1
  goto end
)

git commit -F "%MSGFILE%"
if errorlevel 1 (
  echo.
  echo [err]  git commit failed
  call :unstamp
  set SAVE_ERROR=1
  goto end
)
del "%STAMP_VERSION%" "%STAMP_SW%" "%MSGFILE%" >nul 2>nul

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
  if "%RELEASE_MODE%"=="1" echo [warn] nothing was pushed, so no release was started
  rem Quick mode was asked to push, and did not.
  if "%QUICK%"=="1" set "SAVE_ERROR=1"
  goto end
)

if "%FORCE_MODE%"=="1" goto forcepush

if "%BRANCH%"=="" goto nobranch
rem `quick` was the answer to this question.
if "%QUICK%"=="1" goto dopush
echo.
set /p DOPUSH=push to %REMOTE%/%BRANCH%? (y/n):
if /i not "%DOPUSH%"=="y" goto skipped

:dopush
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
rem Both remedies below rewrite something - the working tree or the remote -
rem and quick mode answers no to each, so it stops here with the commit kept.
if "%QUICK%"=="1" (
  echo [err]  quick mode does not pull or force push - the commit is saved locally.
  echo        pull, resolve, and push by hand.
  set "SAVE_ERROR=1"
  goto end
)
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
rem A refused lease is the normal failure here, and it used to fall through to
rem "force pushed" all the same. Say what happened instead.
if errorlevel 1 (
  echo.
  echo [err]  force push refused - %REMOTE%/%BRANCH% moved since the last fetch, or the push failed
  echo        nothing on the remote was overwritten. The commit is saved locally.
  if "%RELEASE_MODE%"=="1" echo [warn] nothing was pushed, so no release was started
  set SAVE_ERROR=1
  goto end
)
echo.
echo [git]  force pushed %REMOTE%/%BRANCH%
if "%RELEASE_MODE%"=="1" call :runrelease
goto end

:pushed
echo.
echo [git]  pushed %REMOTE%/%BRANCH%
if "%RELEASE_MODE%"=="1" call :runrelease
goto end

:skipped
echo.
echo [git]  push skipped
if "%RELEASE_MODE%"=="1" echo [warn] nothing was pushed, so no release was started
goto end

rem Options 3 and 7 (`release`, `release all`): start the "Release apps"
rem workflow once the push is in. It builds the systems RELEASE_SYSTEMS names
rem on GitHub and publishes one release in KostaJovanovic/mbrd itself
rem (.github/workflows/release.yml), with the
rem branch just pushed. It needs the GitHub CLI, logged in. Non-fatal: the
rem commit and the push already happened, and the Actions tab can still start
rem the workflow by hand.
:runrelease
where gh >nul 2>nul
if errorlevel 1 goto releasenogh
echo.
if "%RELEASE_SYSTEMS%"=="all" (
  echo [gh]   start Release apps for v%VERLABEL% - Windows, macOS, Linux, Android
) else (
  echo [gh]   start Release apps for v%VERLABEL% - Windows and Android only
)
gh workflow run release.yml -R KostaJovanovic/mbrd --ref %BRANCH% -f publish=true -f systems=%RELEASE_SYSTEMS%
if errorlevel 1 goto releasefail
echo [gh]   started - the release goes live when every build is done:
echo        https://github.com/KostaJovanovic/mbrd/actions/workflows/release.yml
exit /b 0
:releasenogh
echo [warn] gh, the GitHub CLI, is not installed - start Release apps from the Actions tab
exit /b 0
:releasefail
echo [warn] gh could not start Release apps - is it logged in? Start it from the Actions tab
exit /b 0

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

:countfail
echo.
echo [err]  could not read COMMIT_COUNT from web/assets/js/version.js - not saving
echo        expected a line of the form:  export const COMMIT_COUNT = 301;
echo        refusing to guess: a wrong count sends the version backwards, and a
echo        falling Android versionCode strands every installed copy.
set SAVE_ERROR=1
goto end

:stampkeepfail
echo.
echo [err]  could not copy version.js and sw.js to %TEMP% - not saving
echo        nothing has been stamped, so the tree is as it was.
set SAVE_ERROR=1
goto end

rem Put back the two files the stamps rewrote, from the copies made before the
rem stamps. Called on every error exit after them, so the next save reads the
rem same count and uses the same version number again.
:unstamp
copy /y "%STAMP_VERSION%" "web\assets\js\version.js" >nul
if errorlevel 1 goto unstampfail
copy /y "%STAMP_SW%" "web\sw.js" >nul
if errorlevel 1 goto unstampfail
del "%STAMP_VERSION%" "%STAMP_SW%" >nul 2>nul
echo        the version stamps are put back - the next save is v%VERLABEL% again.
exit /b 0
:unstampfail
echo [warn] could not put the version stamps back - restore web\assets\js\version.js
echo        and web\sw.js from %STAMP_VERSION% and %STAMP_SW%
exit /b 0


rem Option 6 (`portable`): the portable copy in desktop\portable\, from the
rem files on disk. No stamp, no commit, no push.
rem
rem It used to run after every commit. It takes about ninety seconds, it
rem downloads Electron when the cache is cold, and it ships nothing: the folder
rem is gitignored. A save paid for it every time, and a network error at the
rem end of a good save read as a failure. Now it runs only when asked.
rem
rem The web bundle builds first, because electron-builder copies ../web
rem wholesale and index.html loads assets/app.js: without the build, the copy
rem carries whatever bundle was last built. portable.mjs builds into a scratch
rem folder and swaps it in only on success, so a failure leaves the old copy
rem and its data\ folder as they were.
rem
rem desktop\node_modules is the gate: the shell is a second package with its own
rem install (see CLAUDE.md), and most checkouts have never run it.
:portableonly
echo.
echo === portable ===
echo.
set SAVE_ERROR=0
if not exist "desktop\node_modules" (
  echo [err]  desktop\node_modules is not installed - run "npm install" in desktop\ first
  set SAVE_ERROR=1
  goto end
)
echo [bld]  bundle
call npm run build
if errorlevel 1 (
  echo.
  echo [err]  the bundle did not build - no portable copy was made
  set SAVE_ERROR=1
  goto end
)
echo [bld]  portable copy
call npm run portable
if errorlevel 1 (
  echo.
  echo [err]  the portable copy did not rebuild - desktop\portable\ is unchanged
  echo        a download error such as 504 is the network: run this again.
  set SAVE_ERROR=1
  goto end
)
echo.
echo [portable] desktop\portable\ is current
goto end


:end
echo.
rem The pause keeps a double-clicked window open long enough to read. In quick
rem mode there is no window of its own and nobody to press a key, so it would
rem only hang the caller.
if not "%QUICK%"=="1" pause
exit /b %SAVE_ERROR%
