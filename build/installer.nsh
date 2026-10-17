!macro customInit
  ${if} ${isUpdated}
    nsExec::ExecToStack 'taskkill /IM "iMenu Impressora.exe" /T /F'
    Pop $0
    Pop $1
    Sleep 750
  ${endIf}
!macroend

; Silent auto-updates bypass the installer's Finish page, so reopen the printer.
!macro customInstall
  ${if} ${isUpdated}
    ${if} ${Silent}
      Exec '"$INSTDIR\iMenu Impressora.exe"'
    ${endIf}
  ${endIf}
!macroend
