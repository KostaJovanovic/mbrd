; mbrd - ONE Windows installer that installs OR sets up a portable copy.
;
; A port of FileAnalyser's desktop/build/installer.nsh. electron-builder puts
; this file (nsis.include) at the top of its NSIS script, ahead of its own
; template, and expands the macros below at the hooks that template offers.
;
; Three steps, in the app's paper look (tokens.css, the middle whimsy tier):
;
;   1  "How do you want mbrd?" (customWelcomePage, full window). Two cards:
;      Install, with a box "Open .mbrd files with mbrd" ticked at first, or
;      Portable with its own folder box. An update run (/S --updated, from
;      updates.ts) never sees it, and neither does the elevated second copy of
;      the installer that UAC starts.
;   2  the template's progress page, restyled (customPageAfterChangeDir).
;   3  "mbrd is ready" (customFinishPage, full window), with a box that starts
;      mbrd.
;
; The template's two other pages never show. "Only for me / for everyone"
; always skips (customInstallMode): an install goes to this user account,
; unless the computer already has an everyone-copy, which is then updated where
; it is. The folder page is off (allowToChangeInstallationDirectory: false in
; electron-builder.yml): an install goes to the usual per-user folder, and the
; portable folder comes from page 1.
;
; The template has no portable mode. Its install section always runs the
; uninstaller of any installed copy first (an upgrade, as it sees it), then
; writes the uninstall registry keys and the shortcuts. A portable copy must do
; none of that, so the portable choice never reaches that section. Section 0
; (below) unpacks the app into the folder and writes the `portable` marker,
; which main.ts reads to keep the data folder beside mbrd.exe. Section 1, the
; template's install section, is switched off: no registry key, no shortcut, no
; uninstaller, no association, and an installed copy is left alone. For an
; install, section 0 is off and section 1 runs as it always did.
;
; Section 0 is ours because customHeader comes before the template's own
; Section "install". customInstall stops the build if that ever changes, and
; customHeader stops it if any hook is not expanded.

; DPI-aware, so Windows draws the installer at the display's real resolution
; instead of stretching a 96-dpi picture of it, which blurs every letter on a
; scaled display.
ManifestDPIAware true

; The paper look at the middle whimsy tier (tokens.css :root --paper, --ink,
; --ink-2, --accent). Light only: themed Windows radio buttons ignore a text
; colour, so dark text on a dark page would vanish.
!define MBRD_BG     faf8f3
!define MBRD_INK    31261b
!define MBRD_MUTED  615141
!define MBRD_ACCENT b94900
!define MUI_TEXTCOLOR ${MBRD_INK}

; The uninstaller is compiled from this same file with BUILD_UNINSTALLER set,
; and it uses none of this. A variable it declares but never uses is a warning,
; and electron-builder treats warnings as errors - so the uninstaller declares
; none.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT mbrdGuiInit
  Var mbrdPortable
  Var mbrdPortableDir
  Var mbrdAssociate
  Var mbrdPage
  Var mbrdRadioInstall
  Var mbrdRadioPortable
  Var mbrdBarInstall
  Var mbrdBarPortable
  Var mbrdAssocBox
  Var mbrdDirBox
  Var mbrdFontMono
  Var mbrdFontHeading
  Var mbrdFontTitle
  Var mbrdFontBody
  Var mbrdFontHeader
  !ifndef HIDE_RUN_AFTER_FINISH
    Var mbrdRunBox
  !endif
!endif

; Removes .mbrd only while it still points at this copy, so neither an
; unticked box nor an uninstall takes it away from another copy or program.
!macro mbrdUnassociate
  ReadRegStr $0 HKCU "Software\Classes\mbrd.board\shell\open\command" ""
  ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\mbrd.board"
    ReadRegStr $1 HKCU "Software\Classes\.mbrd" ""
    ${if} $1 == "mbrd.board"
      DeleteRegKey HKCU "Software\Classes\.mbrd"
    ${endif}
  ${endif}
!macroend

; SHCNE_ASSOCCHANGED, so Explorer shows the new icon and handler at once.
!macro mbrdAssocChanged
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customWelcomePage
  !define /ifndef MBRD_WELCOME_HOOK
  Page custom mbrdModeShow mbrdModeLeave
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    !define /ifndef MBRD_INSTALLMODE_HOOK
    ${if} $mbrdPortable == "1"
      !insertmacro setInstallModePerUser
      StrCpy $INSTDIR $mbrdPortableDir
      Abort
    ${elseif} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      ; An everyone-copy is already there: update it in place rather than put
      ; a second copy in this account. The template asks for elevation.
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  !endif
!macroend

!macro customInit
  ; The portable section starts switched off, so a silent run - the updater's
  ; - installs as it always did. Page 1 switches it on when the user asks.
  SectionSetFlags 0 0
  ; The association answer from the last install, so a silent update repeats
  ; it and page 1 shows it. Ticked the first time.
  ReadRegStr $mbrdAssociate HKCU "Software\mbrd" "AssociateMbrd"
  ${if} $mbrdAssociate != "0"
    StrCpy $mbrdAssociate "1"
  ${endif}
!macroend

; Inside the template's install section, so only an install gets here.
!macro customInstall
  !if ${INSTALL_SECTION_ID} != 1
    !error "installer.nsh: the install section is no longer section 1 - fix the SectionSetFlags numbers"
  !endif
  !ifndef BUILD_UNINSTALLER
    WriteRegStr HKCU "Software\mbrd" "AssociateMbrd" "$mbrdAssociate"
    ${if} $mbrdAssociate == "1"
      WriteRegStr HKCU "Software\Classes\.mbrd" "" "mbrd.board"
      WriteRegStr HKCU "Software\Classes\mbrd.board" "" "mbrd board"
      WriteRegStr HKCU "Software\Classes\mbrd.board\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
      WriteRegStr HKCU "Software\Classes\mbrd.board\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    ${else}
      !insertmacro mbrdUnassociate
    ${endif}
    !insertmacro mbrdAssocChanged
  !endif
!macroend

; An update runs the old uninstaller first, with --updated, and the new
; installer then writes the association again from AssociateMbrd. So only a
; real uninstall takes it away, and the stored answer with it. The data folder
; stays either way: the boards are .mbrd files wherever they were saved, but the
; recovery store and the shelf are work, so a reinstall comes back to them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro mbrdUnassociate
    DeleteRegValue HKCU "Software\mbrd" "AssociateMbrd"
    DeleteRegKey /ifempty HKCU "Software\mbrd"
    !insertmacro mbrdAssocChanged
  ${endif}
!macroend

; Sits right before the template's progress page (MUI_PAGE_INSTFILES).
!macro customPageAfterChangeDir
  !define /ifndef MBRD_PROGRESS_HOOK
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW mbrdProgressShow
  ; The page would title its last moment "Installation Complete", which a
  ; portable copy must never read. Blank instead: the done page covers the
  ; header straight after.
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT " "
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT " "
  !define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "mbrd was not set up"
  !define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "Close this window, then run the setup again."
!macroend

; In place of MUI's finish page, whose texts say "installed" either way.
!macro customFinishPage
  !define /ifndef MBRD_FINISH_HOOK
  Page custom mbrdDoneShow mbrdDoneLeave
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !ifndef MBRD_WELCOME_HOOK
      !error "installer.nsh: customWelcomePage was not expanded, so there is no install-or-portable page"
    !endif
    !ifndef MBRD_INSTALLMODE_HOOK
      !error "installer.nsh: customInstallMode was not expanded, so the 'for me or for everyone' page would show"
    !endif
    !ifndef MBRD_PROGRESS_HOOK
      !error "installer.nsh: customPageAfterChangeDir was not expanded, so the progress page keeps the stock look"
    !endif
    !ifndef MBRD_FINISH_HOOK
      !error "installer.nsh: customFinishPage was not expanded, so the last page would say installed for a portable copy"
    !endif
    !ifdef allowToChangeInstallationDirectory
      !error "installer.nsh: set nsis.allowToChangeInstallationDirectory to false - page 1 picks the portable folder, and the template's folder page says install"
    !endif
    !ifndef APP_64
      !error "installer.nsh: the portable section unpacks the x64 package only"
    !endif

    ; Here, not at the top: nsDialogs.nsh and WinMessages.nsh come in after
    ; the top of this file, and may define these themselves.
    !define /ifndef MBRD_SS_RIGHT 0x00000002
    !define /ifndef PBM_SETBARCOLOR 0x0409
    !define /ifndef PBM_SETBKCOLOR 0x2001

    Section "-mbrdPortable"
      ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ; A running copy locks its files, and a half-replaced copy is worse
        ; than none. A running exe cannot be opened for writing, so that is
        ; the test.
        mbrdRetry:
        ClearErrors
        FileOpen $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
        ${if} ${Errors}
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "mbrd is running from $INSTDIR. Close it, then click Retry." IDRETRY mbrdRetry
          Quit
        ${endif}
        FileClose $1
        ; Clear the old app files, so no page or script from the last version
        ; stays behind. The data folder, which holds the boards' recovery store
        ; and the shelf, stays.
        RMDir /r "$INSTDIR\resources"
        RMDir /r "$INSTDIR\locales"
      ${endif}
      CreateDirectory "$INSTDIR"
      InitPluginsDir
      ; Our own line on the progress page, and none of NSIS's own: those read
      ; "Extract:" and the like.
      SetDetailsPrint textonly
      DetailPrint "Copying mbrd into $INSTDIR"
      SetDetailsPrint none
      ; The same File line as the template's x64_app_files, compression
      ; switches and all, so NSIS stores the app package once, not twice
      ; (SetDatablockOptimize is on by default).
      !ifdef COMPRESS
        SetCompress off
      !endif
      File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
      !ifdef COMPRESS
        SetCompress "${COMPRESS}"
      !endif
      SetOutPath "$INSTDIR"
      Nsis7z::Extract "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
      Delete "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
      ; The same text scripts/portable.mjs writes into the marker.
      FileOpen $0 "$INSTDIR\portable" w
      FileWrite $0 "This copy of mbrd keeps its data in the data folder beside it.$\r$\n"
      FileClose $0
      ; The done page's "Start mbrd" box starts this.
      StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      SetDetailsPrint textonly
      DetailPrint "The portable copy is ready."
      SetDetailsPrint none
    SectionEnd

    ; ---- the window ----------------------------------------------------------

    Function mbrdGuiInit
      ; Paper behind every page and around the buttons.
      SetCtlColors $HWNDPARENT ${MBRD_INK} ${MBRD_BG}
      ; No "mbrd 0.x" branding line and no etched rules.
      ShowWindow $mui.Branding.Background ${SW_HIDE}
      ShowWindow $mui.Branding.Text ${SW_HIDE}
      ShowWindow $mui.Line.Standard ${SW_HIDE}
      ShowWindow $mui.Line.FullWindow ${SW_HIDE}
      ; Segoe UI is the Windows interface font. Consolas stands in for the
      ; app's mono labels (Geist Mono ships as WOFF2, which Windows cannot load
      ; here).
      CreateFont $mbrdFontMono "Consolas" 8 400
      CreateFont $mbrdFontHeading "Segoe UI Semibold" 16 400
      CreateFont $mbrdFontTitle "Segoe UI Semibold" 10 400
      CreateFont $mbrdFontBody "Segoe UI" 9 400
      CreateFont $mbrdFontHeader "Segoe UI Semibold" 9 400
      SendMessage $mui.Header.Text ${WM_SETFONT} $mbrdFontHeader 0
      SetCtlColors $mui.Header.SubText ${MBRD_MUTED} ${MBRD_BG}
      ; The progress page moves on to the done page by itself, as MUI's own
      ; finish page arranges.
      SetAutoClose true
    FunctionEnd

    ; Pages 1 and 3 fill the window, as MUI's welcome and finish pages do: the
    ; page covers the header, and the header's texts hide so Alt cannot show
    ; them through it. The branding and the rules stay hidden throughout.
    Function mbrdFullWindowOn
      LockWindow on
      ShowWindow $mui.Header.Text ${SW_HIDE}
      ShowWindow $mui.Header.SubText ${SW_HIDE}
      ShowWindow $mui.Header.Image ${SW_HIDE}
      LockWindow off
    FunctionEnd

    Function mbrdFullWindowOff
      LockWindow on
      ShowWindow $mui.Header.Text ${SW_NORMAL}
      ShowWindow $mui.Header.SubText ${SW_NORMAL}
      ShowWindow $mui.Header.Image ${SW_NORMAL}
      LockWindow off
    FunctionEnd

    ; A small mono label in the accent, above each page's heading.
    Function mbrdEyebrow
      ${NSD_CreateLabel} 5% 12u 90% 10u "MBRD SETUP"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontMono 0
      SetCtlColors $0 ${MBRD_ACCENT} ${MBRD_BG}
    FunctionEnd

    ; A card: a 1 px frame in the ink from 5 % to 95 % of the page width, and a
    ; 3 px accent bar just inside its left edge, hidden until the card is
    ; chosen. Pixels, not dialog units, so every line is one pixel at any
    ; display scale.
    ; In (stack): top, then height, in dialog units. Out (stack): the bar.
    Function mbrdCard
      Pop $R1
      Pop $R0
      IntOp $R1 $R0 + $R1
      ; Top and bottom: MapDialogRect turns dialog units into pixels.
      System::Call "*(i 0, i R0, i 0, i R1) p .R2"
      System::Call "user32::MapDialogRect(p $mbrdPage, p R2)"
      System::Call "*$R2(i .R6, i .R0, i .R7, i .R1)"
      ; Left and right: 5 % and 95 % of the page's width.
      System::Call "user32::GetClientRect(p $mbrdPage, p R2)"
      System::Call "*$R2(i .R6, i .R7, i .R3, i .R8)"
      System::Free $R2
      IntOp $R4 $R3 * 5
      IntOp $R4 $R4 / 100
      IntOp $R5 $R3 * 95
      IntOp $R5 $R5 / 100
      IntOp $R6 $R5 - $R4
      IntOp $R7 $R1 - $R0
      ${NSD_CreateLabel} $R4 $R0 $R6 1 ""
      Pop $R8
      SetCtlColors $R8 "" ${MBRD_INK}
      IntOp $R9 $R1 - 1
      ${NSD_CreateLabel} $R4 $R9 $R6 1 ""
      Pop $R8
      SetCtlColors $R8 "" ${MBRD_INK}
      ${NSD_CreateLabel} $R4 $R0 1 $R7 ""
      Pop $R8
      SetCtlColors $R8 "" ${MBRD_INK}
      IntOp $R9 $R5 - 1
      ${NSD_CreateLabel} $R9 $R0 1 $R7 ""
      Pop $R8
      SetCtlColors $R8 "" ${MBRD_INK}
      IntOp $R9 $R4 + 1
      IntOp $R3 $R0 + 1
      IntOp $R7 $R7 - 2
      ${NSD_CreateLabel} $R9 $R3 3 $R7 ""
      Pop $R8
      SetCtlColors $R8 "" ${MBRD_ACCENT}
      ShowWindow $R8 ${SW_HIDE}
      Push $R8
    FunctionEnd

    ; ---- page 1: install, or a portable copy --------------------------------

    Function mbrdModeShow
      ; An update run, and the elevated copy UAC starts, go straight on.
      ${if} ${isUpdated}
      ${orIf} ${UAC_IsInnerInstance}
        Abort
      ${endif}
      ${if} $mbrdPortableDir == ""
        StrCpy $mbrdPortableDir "$EXEDIR\${APP_FILENAME}"
      ${endif}
      nsDialogs::Create 1044
      Pop $mbrdPage
      ${if} $mbrdPage == error
        Abort
      ${endif}
      SetCtlColors $mbrdPage ${MBRD_INK} ${MBRD_BG}

      Call mbrdEyebrow
      ${NSD_CreateLabel} 5% 23u 90% 22u "How do you want mbrd?"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontHeading 0
      SetCtlColors $0 ${MBRD_INK} ${MBRD_BG}

      ; Card 1: install, with the association box.
      Push 50
      Push 60
      Call mbrdCard
      Pop $mbrdBarInstall
      ${NSD_CreateRadioButton} 8% 56u 55% 12u "Install"
      Pop $mbrdRadioInstall
      SendMessage $mbrdRadioInstall ${WM_SETFONT} $mbrdFontTitle 0
      SetCtlColors $mbrdRadioInstall ${MBRD_INK} ${MBRD_BG}
      ${NSD_OnClick} $mbrdRadioInstall mbrdModeClick
      ${NSD_CreateLabel} 64% 58u 28% 10u "RECOMMENDED"
      Pop $0
      ${NSD_AddStyle} $0 ${MBRD_SS_RIGHT}
      SendMessage $0 ${WM_SETFONT} $mbrdFontMono 0
      SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
      ${NSD_OnClick} $0 mbrdPickInstall
      ${NSD_CreateLabel} 12% 70u 80% 20u "Adds mbrd to the Start menu and the desktop. It updates itself, and Windows Settings can remove it."
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
      SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
      ${NSD_OnClick} $0 mbrdPickInstall
      ${NSD_CreateCheckBox} 12% 92u 80% 12u "Open .mbrd files with mbrd"
      Pop $mbrdAssocBox
      SendMessage $mbrdAssocBox ${WM_SETFONT} $mbrdFontBody 0
      SetCtlColors $mbrdAssocBox ${MBRD_INK} ${MBRD_BG}
      ${if} $mbrdAssociate == "1"
        ${NSD_Check} $mbrdAssocBox
      ${endif}
      ; The box belongs to an install, so ticking it picks the Install card.
      ${NSD_OnClick} $mbrdAssocBox mbrdPickInstall

      ; Card 2: a portable copy, with its folder. No association: that is a
      ; registry write, which a portable copy promises not to make.
      Push 116
      Push 72
      Call mbrdCard
      Pop $mbrdBarPortable
      ${NSD_CreateRadioButton} 8% 122u 55% 12u "Portable"
      Pop $mbrdRadioPortable
      SendMessage $mbrdRadioPortable ${WM_SETFONT} $mbrdFontTitle 0
      SetCtlColors $mbrdRadioPortable ${MBRD_INK} ${MBRD_BG}
      ${NSD_OnClick} $mbrdRadioPortable mbrdModeClick
      ${NSD_CreateLabel} 12% 136u 80% 24u "Runs from a folder you choose, for example on a USB stick. It writes nothing to this computer. To remove it, delete the folder."
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
      SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
      ${NSD_OnClick} $0 mbrdPickPortable
      ${NSD_CreateText} 12% 164u 60% 13u "$mbrdPortableDir"
      Pop $mbrdDirBox
      SendMessage $mbrdDirBox ${WM_SETFONT} $mbrdFontBody 0
      SetCtlColors $mbrdDirBox ${MBRD_INK} ${MBRD_BG}
      ${NSD_OnChange} $mbrdDirBox mbrdPickPortable
      ${NSD_CreateBrowseButton} 74% 163u 18% 15u "Browse..."
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
      ${NSD_OnClick} $0 mbrdBrowse

      ${if} $mbrdPortable == "1"
        ${NSD_Check} $mbrdRadioPortable
      ${else}
        ${NSD_Check} $mbrdRadioInstall
      ${endif}
      Call mbrdModeSync
      Call mbrdFullWindowOn
      nsDialogs::Show
      Call mbrdFullWindowOff
    FunctionEnd

    ; The chosen card gets its accent bar, and the button says what it does.
    Function mbrdModeSync
      ${NSD_GetState} $mbrdRadioPortable $0
      GetDlgItem $1 $HWNDPARENT 1
      ${if} $0 == ${BST_CHECKED}
        ShowWindow $mbrdBarInstall ${SW_HIDE}
        ShowWindow $mbrdBarPortable ${SW_SHOW}
        SendMessage $1 ${WM_SETTEXT} 0 "STR:Set up"
      ${else}
        ShowWindow $mbrdBarPortable ${SW_HIDE}
        ShowWindow $mbrdBarInstall ${SW_SHOW}
        SendMessage $1 ${WM_SETTEXT} 0 "STR:Install"
      ${endif}
    FunctionEnd

    Function mbrdModeClick
      Pop $0
      Call mbrdModeSync
    FunctionEnd

    ; A click anywhere in a card's text picks that card.
    Function mbrdPickInstall
      Pop $0
      ${NSD_Uncheck} $mbrdRadioPortable
      ${NSD_Check} $mbrdRadioInstall
      Call mbrdModeSync
    FunctionEnd

    ; Also runs when the folder box changes: typing a folder means portable.
    Function mbrdPickPortable
      Pop $0
      ${NSD_Uncheck} $mbrdRadioInstall
      ${NSD_Check} $mbrdRadioPortable
      Call mbrdModeSync
    FunctionEnd

    Function mbrdBrowse
      Pop $0
      ${NSD_GetText} $mbrdDirBox $1
      nsDialogs::SelectFolderDialog "Choose where the portable copy goes." $1
      Pop $1
      ${if} $1 != error
        Push $1
        Call mbrdFolder
        Pop $1
        ; Fires the box's change callback, which picks the portable card.
        ${NSD_SetText} $mbrdDirBox $1
      ${endif}
    FunctionEnd

    ; The portable folder always ends in \mbrd, as the template's folder page
    ; made sure of: picking D:\ puts the copy in D:\mbrd, not loose in the root
    ; of the drive. In and out: the stack.
    Function mbrdFolder
      Exch $R0
      Push $R1
      mbrdFolderTrim:
        StrCpy $R1 $R0 1 -1
        ${if} $R1 == "\"
        ${orIf} $R1 == "/"
          StrCpy $R0 $R0 -1
          Goto mbrdFolderTrim
        ${endif}
      ${GetFileName} $R0 $R1
      ${if} $R1 != "${APP_FILENAME}"
        StrCpy $R0 "$R0\${APP_FILENAME}"
      ${endif}
      Pop $R1
      Exch $R0
    FunctionEnd

    Function mbrdModeLeave
      ${NSD_GetState} $mbrdRadioPortable $0
      ${if} $0 == ${BST_CHECKED}
        ${NSD_GetText} $mbrdDirBox $1
        ; A full path only: a drive (D:\...) or a network share (\\server\...).
        StrCpy $2 $1 1 1
        StrCpy $3 $1 2
        ${if} $2 != ":"
        ${andIf} $3 != "\\"
          MessageBox MB_OK|MB_ICONEXCLAMATION "Type a full folder path for the portable copy, for example D:\mbrd, or click Browse."
          Abort
        ${endif}
        Push $1
        Call mbrdFolder
        Pop $mbrdPortableDir
        StrCpy $mbrdPortable "1"
        SectionSetFlags 0 1 ; 1 = SF_SELECTED
        SectionSetFlags 1 0
        !ifdef APP_64_UNPACKED_SIZE
          SectionSetSize 0 ${APP_64_UNPACKED_SIZE}
        !endif
      ${else}
        StrCpy $mbrdPortable "0"
        ${NSD_GetState} $mbrdAssocBox $2
        ${if} $2 == ${BST_CHECKED}
          StrCpy $mbrdAssociate "1"
        ${else}
          StrCpy $mbrdAssociate "0"
        ${endif}
        SectionSetFlags 0 0
        SectionSetFlags 1 1
      ${endif}
    FunctionEnd

    ; ---- page 2: progress ------------------------------------------------------

    Function mbrdProgressShow
      FindWindow $0 "#32770" "" $HWNDPARENT
      SetCtlColors $0 ${MBRD_INK} ${MBRD_BG}
      GetDlgItem $1 $0 1006
      SetCtlColors $1 ${MBRD_MUTED} ${MBRD_BG}
      SendMessage $1 ${WM_SETFONT} $mbrdFontBody 0
      ; A flat bar in the accent. Themed, Windows paints its own green one and
      ; ignores the colour. COLORREF is 0x00BBGGRR: b94900 and faf8f3.
      GetDlgItem $1 $0 1004
      System::Call "uxtheme::SetWindowTheme(p r1, w ' ', w ' ')"
      SendMessage $1 ${PBM_SETBARCOLOR} 0 0x000049B9
      SendMessage $1 ${PBM_SETBKCOLOR} 0 0x00F3F8FA
      ${if} $mbrdPortable == "1"
        !insertmacro MUI_HEADER_TEXT "Setting up the portable copy" "mbrd is going into $INSTDIR."
      ${else}
        !insertmacro MUI_HEADER_TEXT "Installing mbrd" "This takes a moment."
      ${endif}
    FunctionEnd

    ; ---- page 3: done ------------------------------------------------------------

    Function mbrdDoneShow
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
      nsDialogs::Create 1044
      Pop $mbrdPage
      ${if} $mbrdPage == error
        Abort
      ${endif}
      SetCtlColors $mbrdPage ${MBRD_INK} ${MBRD_BG}

      Call mbrdEyebrow
      ${NSD_CreateLabel} 5% 23u 90% 22u "mbrd is ready"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $mbrdFontHeading 0
      SetCtlColors $0 ${MBRD_INK} ${MBRD_BG}

      ${if} $mbrdPortable == "1"
        ${NSD_CreateLabel} 5% 52u 90% 12u "The portable copy is in this folder:"
        Pop $0
        SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
        SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
        ${NSD_CreateLabel} 5% 66u 90% 12u "$INSTDIR"
        Pop $0
        SendMessage $0 ${WM_SETFONT} $mbrdFontMono 0
        SetCtlColors $0 ${MBRD_INK} ${MBRD_BG}
        ${NSD_CreateLabel} 5% 84u 90% 36u "It keeps its data in the data folder beside it, so the whole folder can move to another computer. To remove it, delete the folder."
        Pop $0
        SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
        SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
      ${else}
        ${NSD_CreateLabel} 5% 52u 90% 36u "mbrd is installed. Start it from the Start menu or the desktop. It updates itself, and Windows Settings can remove it."
        Pop $0
        SendMessage $0 ${WM_SETFONT} $mbrdFontBody 0
        SetCtlColors $0 ${MBRD_MUTED} ${MBRD_BG}
      ${endif}

      !ifndef HIDE_RUN_AFTER_FINISH
        ${NSD_CreateCheckBox} 5% 130u 90% 12u "Start mbrd"
        Pop $mbrdRunBox
        SendMessage $mbrdRunBox ${WM_SETFONT} $mbrdFontBody 0
        SetCtlColors $mbrdRunBox ${MBRD_INK} ${MBRD_BG}
        ${NSD_Check} $mbrdRunBox
      !endif

      Call mbrdFullWindowOn
      nsDialogs::Show
      Call mbrdFullWindowOff
    FunctionEnd

    ; Starts the app the way the template's own finish page does.
    Function mbrdDoneLeave
      !ifndef HIDE_RUN_AFTER_FINISH
        ${NSD_GetState} $mbrdRunBox $0
        ${if} $0 == ${BST_CHECKED}
          ${if} ${isUpdated}
            StrCpy $1 "--updated"
          ${else}
            StrCpy $1 ""
          ${endif}
          ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
        ${endif}
      !endif
    FunctionEnd
  !endif
!macroend
