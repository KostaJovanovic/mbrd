@echo off
setlocal
title mbrd mobile
cd /d "%~dp0"

rem The Android app, built and put on a phone. desktop.bat's counterpart, and
rem a port of FileAnalyser's mobile.bat. Connect a phone over USB with USB
rem debugging on (Settings, About phone, tap "Build number" seven times, then
rem Developer options, USB debugging), then run this.
rem
rem   mobile.bat          build, install on every connected phone, and start it
rem   mobile.bat apk      build only: the APK lands in
rem                       mobile\android\app\build\outputs\apk\debug\
rem   mobile.bat open     stage and sync, then open Android Studio
rem
rem What happens, in order, and why:
rem   1. The root and mobile\ are two packages, each with its own gitignored
rem      dependencies, so a fresh clone installs both here, once.
rem   2. index.html loads assets/app.js, a build artefact, so the bundle is built
rem      first. stage-web.mjs refuses a bundle older than its sources anyway.
rem   3. `npm run sync` stamps the version, stages web\ into mobile\www\, and
rem      `cap sync` copies it into the Android project. The APK carries a copy of
rem      the site, so an edit shows on the phone only after this runs again.
rem   4. Gradle needs JDK 21, and Capacitor 8 does not build on 17. JAVA_HOME is
rem      used when it is 21 or newer. Otherwise this looks in %USERPROFILE%\.jdks
rem      and in the runtime Android Studio bundles.
rem   5. adb installs the debug APK over the previous one and starts it. On every
rem      phone connected, not the first: a bare `adb install` refuses to choose.
set "MBRD_MODE=%~1"

rem `if errorlevel` rather than `||`, as in desktop.bat.
call :install root node_modules .
if errorlevel 1 exit /b 1
call :install mobile mobile\node_modules\@capacitor\cli mobile
if errorlevel 1 exit /b 1

echo.
echo   Building the web bundle...
call npm run build
if errorlevel 1 goto :failed

echo.
echo   Staging web\ and syncing the Android project...
pushd mobile
call npm run sync
set "MBRD_ERR=%errorlevel%"
popd
if not "%MBRD_ERR%"=="0" goto :failed

if /i "%MBRD_MODE%"=="open" (
  pushd mobile
  call npx cap open android
  popd
  exit /b 0
)

call :findjdk
if not defined MBRD_JDK (
  echo.
  echo   Gradle needs JDK 21 or newer, and none was found. Install Android
  echo   Studio, or unzip a JDK 21 into %USERPROFILE%\.jdks\, then run this again.
  pause
  exit /b 1
)
set "JAVA_HOME=%MBRD_JDK%"

echo.
echo   Building the APK with %JAVA_HOME%...
pushd mobile\android
rem .\ and not a bare name: with NoDefaultCurrentDirectoryInExePath set, as some
rem shells and agents set it, cmd does not look in the current folder.
call .\gradlew.bat assembleDebug
set "MBRD_ERR=%errorlevel%"
popd
if not "%MBRD_ERR%"=="0" goto :failed

set "MBRD_APK=mobile\android\app\build\outputs\apk\debug\app-debug.apk"
if /i "%MBRD_MODE%"=="apk" (
  echo.
  echo   Built: %MBRD_APK%
  exit /b 0
)

where adb >nul 2>nul
if errorlevel 1 if defined ANDROID_HOME set "PATH=%PATH%;%ANDROID_HOME%\platform-tools"
where adb >nul 2>nul
if errorlevel 1 (
  echo.
  echo   adb is not on PATH or in %%ANDROID_HOME%%\platform-tools. Install the
  echo   APK by hand: %MBRD_APK%
  pause
  exit /b 0
)

rem `adb devices` lists one phone a line after its header, as "<serial>
rem device". Other states (unauthorized, offline) cannot take an install.
set "MBRD_PHONES=0"
for /f "skip=1 tokens=1,2" %%a in ('adb devices') do if "%%b"=="device" call :phone %%a
if "%MBRD_PHONES%"=="0" (
  echo.
  echo   No phone found over adb. Connect one with USB debugging on, and accept
  echo   the prompt on it, or install this APK by hand: %MBRD_APK%
  pause
  exit /b 0
)
echo.
echo   Started on %MBRD_PHONES% phone(s). Make an edit, then run mobile.bat again.
exit /b 0

rem ---------------------------------------------------------------------------

rem One phone: %1 is its serial.
:phone
echo.
echo   Installing on %1...
adb -s %1 install -r "%MBRD_APK%"
if errorlevel 1 (
  echo   adb could not install on %1. See above.
  exit /b 0
)
adb -s %1 shell am start -n com.valjdakosta.mbrd/.MainActivity >nul
set /a MBRD_PHONES+=1
exit /b 0

rem A package's dependencies, installed when they are missing: %1 names it for
rem the message, %2 is the folder that proves it is installed, %3 is where npm
rem runs. As desktop.bat's.
:install
if exist "%~2\" exit /b 0
echo.
echo   First run - installing the %~1 dependencies. This takes a minute.
echo.
pushd "%~3"
call npm install --no-audit --no-fund
popd
if exist "%~2\" exit /b 0
echo.
echo   npm install failed in %~3. Fix that first, then run this again.
pause
exit /b 1

rem A JDK 21 or newer into MBRD_JDK. The first hit wins.
:findjdk
set "MBRD_JDK="
if defined JAVA_HOME call :tryjdk "%JAVA_HOME%"
for /d %%d in ("%USERPROFILE%\.jdks\*") do call :tryjdk "%%~d"
call :tryjdk "%ProgramFiles%\Android\Android Studio\jbr"
call :tryjdk "%LOCALAPPDATA%\Programs\Android Studio\jbr"
for /d %%d in ("%ProgramFiles%\Eclipse Adoptium\jdk-2*" "%ProgramFiles%\Microsoft\jdk-2*" "%ProgramFiles%\Java\jdk-2*") do call :tryjdk "%%~d"
exit /b 0

rem `java -version` prints `version "21.0.12"`. The dot in the pattern stands
rem for the quote, which findstr cannot take inside /c:"...".
:tryjdk
if defined MBRD_JDK exit /b 0
if not exist "%~1\bin\java.exe" exit /b 0
"%~1\bin\java.exe" -version 2>&1 | findstr /r /c:"version .2[1-9]" /c:"version .[3-9][0-9]" >nul && set "MBRD_JDK=%~1"
exit /b 0

:failed
echo.
echo   Failed. The output above says where.
echo.
pause
exit /b 1
