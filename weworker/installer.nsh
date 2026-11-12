!define WEWORKER_INSTALLER_SOURCE_DIR "${__FILEDIR__}"

; Run before the OLD uninstaller, whose shutdown behavior may be incomplete.
; Keep electron-builder's atomic file removal and run-after-finish handling.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\weworker-stop-installed-app.ps1 "${WEWORKER_INSTALLER_SOURCE_DIR}\scripts\stop-installed-app.ps1"
  nsExec::ExecToStack /TIMEOUT=20000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\weworker-stop-installed-app.ps1" -InstallDirectory "$INSTDIR"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "Unable to close the installed WeWorker processes."
    MessageBox MB_OK|MB_ICONSTOP "Please close WeWorker and its running tasks, then run setup again. Installation has been stopped because the installed processes could not be closed." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
