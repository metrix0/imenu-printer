!macro customInit
  ${if} ${isUpdated}
    ; The installer is a child of the app: /T would terminate the updater too.
    nsExec::ExecToStack 'taskkill /IM "iMenu Impressora.exe" /F'
    Pop $0
    Pop $1
    Sleep 750
  ${endIf}
!macroend

