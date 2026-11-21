; Compile with unique APP_EXECUTABLE_FILENAME, PROBE_OUTFILE and PROBE_DIRECTORY defines.
; Only the generated test application's HKCU registration is changed and cleaned up.
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Moyan association probe"
OutFile "${PROBE_OUTFILE}"
!include "LogicLib.nsh"
!define SHELL_CONTEXT HKCU
!define PRODUCT_NAME "Moyan association probe"
!include "${PROBE_INSTALLER_INCLUDE}"

Section
  StrCpy $INSTDIR "${PROBE_DIRECTORY}"
  StrCpy $9 "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "$9\shell\open\command" "" '$\"C:\old portable\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  !insertmacro customInstall
  ReadRegStr $0 HKCU "$9\shell\open\command" ""
  ${if} $0 != '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    SetErrorLevel 1
    Goto cleanup
  ${endif}
  ClearErrors
  ReadRegStr $0 HKCU "$9\SupportedTypes" ".md"
  ${if} ${Errors}
    SetErrorLevel 2
    Goto cleanup
  ${endif}
  ClearErrors
  ReadRegStr $0 HKCU "$9\SupportedTypes" ".markdown"
  ${if} ${Errors}
    SetErrorLevel 3
    Goto cleanup
  ${endif}
  WriteRegStr HKCU "$9\shell\open\command" "" '$\"C:\another install\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  !insertmacro customUnInstall
  ReadRegStr $0 HKCU "$9\shell\open\command" ""
  ${if} $0 != '$\"C:\another install\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    SetErrorLevel 4
    Goto cleanup
  ${endif}
  !insertmacro customInstall
  !insertmacro customUnInstall
  ClearErrors
  ReadRegStr $0 HKCU "$9\shell\open\command" ""
  ${ifNot} ${Errors}
    SetErrorLevel 5
    Goto cleanup
  ${endif}
  SetErrorLevel 0
cleanup:
  DeleteRegKey HKCU "$9"
SectionEnd
