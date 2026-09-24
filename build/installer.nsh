; Included by electron-builder's NSIS installer (nsis.include in electron-builder.yml).

; Always install for the current user: the app needs no administrator rights, so the
; installer skips the "current user / all users" page and does not ask for elevation.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; electron-builder's /allusers switch would still elevate and install for all users,
; which this installer does not support. customInit runs before anything is installed.
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "$(^Name) installs for the current user only, so /allusers is not supported." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
