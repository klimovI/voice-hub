; Extend Tauri's "Delete the application data" checkbox to also drop the
; Windows Credential Manager entry. Target name is `{user}.{service}` per
; keyring v3 windows-native, i.e. `host.voice-hub` for our Entry.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState == 1
    nsExec::Exec 'cmdkey /delete:host.voice-hub'
    Pop $0
  ${EndIf}
!macroend
