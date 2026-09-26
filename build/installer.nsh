!macro customInit
  ${if} ${isUpdated}
    nsExec::ExecToStack 'taskkill /IM "iMenu Impressora.exe" /T /F'
    Pop $0
    Pop $1
    Sleep 750
  ${endIf}
!macroend
