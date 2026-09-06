; One Setup.exe that asks Install or Portable, as Winaero Tweaker does.
;
; The decision is plan §1: a single Windows download rather than two, because
; two downloads is a question asked on a web page by somebody who has not yet
; seen the app, and this is the same question asked by the installer that can
; actually act on the answer.
;
; ── What Portable means here, and what it costs ──
;
; No registry, no Start menu, no uninstaller, no file association. That is the
; whole promise of a portable copy: it writes nothing outside its own folder, so
; a USB stick with it on comes back off the machine leaving no trace. Two
; consequences follow and both were agreed up front:
;
;   - **No auto-update.** electron-updater replaces an *installed* copy. A
;     portable one gets a "new version available" notice that opens the release
;     page instead. See desktop/updates.ts.
;   - **No file association.** Registering .mbrd is a registry write, which is
;     the thing portable promises not to do. Double-clicking a board opens the
;     installed copy if there is one; drag-and-drop and File -> Open work in
;     both.
;
; The marker file beside the exe is how the app itself knows. main.ts looks for
; it before `ready` and moves userData to `data/` next to the executable - and
; if that folder cannot be made, because the medium is read-only, it falls back
; to AppData and says so in a toast rather than refusing to start.

; This file is included near the *top* of the script electron-builder
; generates, before it includes the standard headers itself - so the three
; things a custom page needs have to be asked for here. All three carry their
; own include guards, so asking twice costs nothing and is the documented way.
!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh

; $PortableMode is set in preInit, which runs in both compilation passes, so
; it is declared out here. The two radio handles are the page's alone and are
; declared inside the same guard the page is - NSIS warns about a variable that
; is declared and never touched, and a warning is an error here.
Var PortableMode

; The page stands *after* the directory page, which is the hook
; electron-builder actually inserts - `customWelcomePage` is declared in its
; template but is not reached in this configuration, and the symptom is a page
; that never draws and an NSIS warning that the function is unreferenced.
;
; After the directory page turns out to be the better order anyway. The person
; chooses a folder and then says what should happen in it, so a portable copy
; goes exactly where they put it rather than somewhere this script decided -
; which is the whole promise of a portable copy, and one it should not be
; making on their behalf.
!macro customPageAfterChangeDir
  Page custom ModePageShow ModePageLeave
!macroend

!macro preInit
  StrCpy $PortableMode "0"
!macroend

; Both functions are compiled into the installer only.
;
; electron-builder runs makensis twice - once for the installer and once for the
; uninstaller, with BUILD_UNINSTALLER defined - and the whole page sequence,
; this hook included, sits inside an `!ifndef BUILD_UNINSTALLER` in its
; template. So on the second pass the page is never inserted, these two
; functions are unreferenced, NSIS warns, and electron-builder treats a warning
; as an error: a build that fails on a file that is entirely correct.
!ifndef BUILD_UNINSTALLER

Var RadioInstall
Var RadioPortable

Function ModePageShow
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u \
    "mbrd can be installed like an ordinary application, or unpacked into a \
folder and run from there - including from a USB stick."
  Pop $0

  ${NSD_CreateRadioButton} 0 32u 100% 12u "Install (recommended)"
  Pop $RadioInstall
  ${NSD_CreateLabel} 12u 45u 100% 20u \
    "Adds a Start menu entry and a desktop shortcut, opens .mbrd files when you \
double-click them, and updates itself."
  Pop $0

  ${NSD_CreateRadioButton} 0 70u 100% 12u "Portable"
  Pop $RadioPortable
  ${NSD_CreateLabel} 12u 83u 100% 28u \
    "Unpacks into a folder and writes nothing anywhere else - no registry, no \
Start menu, no uninstaller. It will not open .mbrd files on double-click and \
will not update itself; you will be told when a new version is out."
  Pop $0

  ${If} $PortableMode == "1"
    ${NSD_Check} $RadioPortable
  ${Else}
    ${NSD_Check} $RadioInstall
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ModePageLeave
  ${NSD_GetState} $RadioPortable $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $PortableMode "1"
    ; $INSTDIR is left exactly as chosen on the page before this one. A portable
    ; copy that relocated itself would be deciding, on somebody's behalf, where
    ; a folder they are about to carry off on a stick should live - which is the
    ; one decision portable exists to hand back to them.
  ${Else}
    StrCpy $PortableMode "0"
  ${EndIf}
FunctionEnd

!endif

; The marker, and the things a portable copy must not do.
;
; electron-builder's own macros write the shortcuts, the uninstaller and the
; registry keys; this removes them again on the portable branch rather than
; trying to prevent them, because the order the generated script runs in is not
; this file's to change. The result is the same and the failure mode is louder:
; a key that is written and deleted is visible in the log, where a key that was
; never written is indistinguishable from a macro that stopped being called.
!macro customInstall
  ${If} $PortableMode == "1"
    FileOpen $0 "$INSTDIR\portable" w
    FileWrite $0 "This copy of mbrd keeps its data in the data folder beside it.$\r$\n"
    FileClose $0

    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
    RMDir /r "$SMPROGRAMS\${PRODUCT_FILENAME}"
    Delete "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"

    DeleteRegKey SHCTX "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey SHCTX "${INSTALL_REGISTRY_KEY}"
    ; The file association, which is the other registry write portable declines.
    DeleteRegKey HKCU "Software\Classes\.mbrd"
    DeleteRegKey HKCU "Software\Classes\mbrd.mbrd"
  ${EndIf}
!macroend

; A portable copy has no uninstaller to run, so there is nothing to undo here -
; but an installed one shares this script, and its uninstall must not leave the
; data folder a portable copy would have made beside it.
!macro customUnInstall
  ${IfNot} ${Silent}
    ; The person's boards are never in here - those are .mbrd files wherever
    ; they saved them - but the recovery store and the shelf are, and they are
    ; work. Left alone on purpose, so reinstalling comes back to the same board.
  ${EndIf}
!macroend
