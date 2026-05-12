; Tauri NSIS uninstall hook: wipe app data + keychain after the user
; confirms. Identifier mirrors `identifier` in tauri.conf.json.
; The hook is only invoked on full uninstall, not on in-place update.

!macro NSIS_HOOK_POSTUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Удалить данные приложения (имя пользователя, настройки, сохранённый сервер)?" \
    /SD IDNO IDNO wipe_skip
    ; Guard each RMDir against an empty shell var to avoid resolving to a
    ; drive root in the (theoretical) case where $APPDATA / $LOCALAPPDATA
    ; are unset.
    ${If} $APPDATA != ""
    ${AndIf} ${FileExists} "$APPDATA\com.voice-hub.desktop\*.*"
      RMDir /r "$APPDATA\com.voice-hub.desktop"
    ${EndIf}
    ${If} $LOCALAPPDATA != ""
    ${AndIf} ${FileExists} "$LOCALAPPDATA\com.voice-hub.desktop\*.*"
      RMDir /r "$LOCALAPPDATA\com.voice-hub.desktop"
    ${EndIf}
    nsExec::Exec 'cmdkey /delete:host.voice-hub'
    Pop $0
  wipe_skip:
!macroend
