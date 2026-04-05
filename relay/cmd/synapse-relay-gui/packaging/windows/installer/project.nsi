Unicode true

####
## Custom Synapse Relay Windows installer
####
## Supports:
## - one-click interactive install with no wizard pages
## - silent install via /S
## - scope selection between all users and current user
## - silent scope selection via /ALLUSERS=1 or /CURRENTUSER=1
## - optional silent auto-launch via /AUTOLAUNCH=1
## - install-time unpack of bundled runtimes next to the app
####

!define PRODUCT_EXECUTABLE "synapse-relay-gui.exe"
!define INSTALL_SCOPE_MARKER "install.scope"
!define REQUEST_EXECUTION_LEVEL "user"
!define PRODUCT_INSTALL_DIRNAME "Relay"
!define SYNAPSE_RUNTIME_STAGE "__SYNAPSE_RUNTIME_STAGE__"

!include "wails_tools.nsh"

VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

ManifestDPIAware true
ManifestLongPathAware true

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Icon "..\icon.ico"
UninstallIcon "..\icon.ico"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"
InstallDir "$LOCALAPPDATA\Programs\${INFO_COMPANYNAME}\${PRODUCT_INSTALL_DIRNAME}"
ShowInstDetails nevershow
AutoCloseWindow true
SilentInstall normal
SilentUnInstall normal

Page instfiles
UninstPage instfiles

Var AutoLaunch
Var InstallScope
Var un.InstallScope

Function SelectInstallScope
    ReadRegStr $R3 HKLM "${UNINST_KEY}" "InstallLocation"
    ReadRegStr $R4 HKCU "${UNINST_KEY}" "InstallLocation"

    ${If} $InstallScope == ""
        ${If} $R3 != ""
            ${If} $R4 != ""
                IfSilent preferCurrentUser promptExistingScope
            ${Else}
                StrCpy $InstallScope "all"
                Goto applyScope
            ${EndIf}
        ${ElseIf} $R4 != ""
            StrCpy $InstallScope "current"
            Goto applyScope
        ${Else}
            IfSilent preferCurrentUser promptNewScope
        ${EndIf}
    ${Else}
        Goto applyScope
    ${EndIf}

    promptExistingScope:
        MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 \
            "${INFO_PRODUCTNAME} is already installed for all users and for the current user.$\r$\n$\r$\nYes = replace the all-users install.$\r$\nNo = replace the current-user install." \
            IDYES chooseAllUsers IDNO chooseCurrentUser
        Abort

    promptNewScope:
        MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 \
            "Choose how to install ${INFO_PRODUCTNAME}:$\r$\n$\r$\nYes = install for all users (requires administrator approval).$\r$\nNo = install only for the current user.$\r$\nCancel = stop installation." \
            IDYES chooseAllUsers IDNO chooseCurrentUser
        Abort

    preferCurrentUser:
        StrCpy $InstallScope "current"
        Goto applyScope

    chooseAllUsers:
        StrCpy $InstallScope "all"
        Goto applyScope

    chooseCurrentUser:
        StrCpy $InstallScope "current"

    applyScope:
        ${If} $InstallScope == "all"
            ${If} $R3 != ""
                StrCpy $INSTDIR $R3
            ${Else}
                StrCpy $INSTDIR "$PROGRAMFILES64\${INFO_COMPANYNAME}\${PRODUCT_INSTALL_DIRNAME}"
            ${EndIf}
        ${Else}
            ${If} $R4 != ""
                StrCpy $INSTDIR $R4
            ${Else}
                StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${INFO_COMPANYNAME}\${PRODUCT_INSTALL_DIRNAME}"
            ${EndIf}
        ${EndIf}
FunctionEnd

Function RelaunchAsAdmin
    ClearErrors
    ExecShell "runas" "$EXEPATH" "$R0 /ALLUSERS=1 /ELEVATED=1"
FunctionEnd

Function EnsureInstallElevation
    ${If} $InstallScope != "all"
        Return
    ${EndIf}
    ${If} $R5 == "1"
        Return
    ${EndIf}

    Call RelaunchAsAdmin
    ${IfNot} ${Errors}
        Quit
    ${EndIf}

    IfSilent denySilentInstall offerPerUserFallback
    denySilentInstall:
        SetErrorLevel 740
        Abort

    offerPerUserFallback:
        MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 \
            "Administrator approval was not granted.$\r$\n$\r$\nInstall only for the current user instead?" \
            IDYES switchToCurrentUser
        Abort

    switchToCurrentUser:
        StrCpy $InstallScope "current"
        Call SelectInstallScope
FunctionEnd

Function ApplyShellContext
    ${If} $InstallScope == "all"
        SetShellVarContext all
    ${Else}
        SetShellVarContext current
    ${EndIf}
FunctionEnd

Function WriteScopedUninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    SetRegView 64
    ${If} $InstallScope == "all"
        WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${INFO_COMPANYNAME}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${INFO_PRODUCTNAME}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${INFO_PRODUCTVERSION}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXECUTABLE}"
        WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
        WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
        WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
        WriteRegStr HKLM "${UNINST_KEY}" "InstallScope" "$InstallScope"
        WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
        WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
    ${Else}
        WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${INFO_COMPANYNAME}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${INFO_PRODUCTNAME}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${INFO_PRODUCTVERSION}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXECUTABLE}"
        WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
        WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
        WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
        WriteRegStr HKCU "${UNINST_KEY}" "InstallScope" "$InstallScope"
        WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
        WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
    ${EndIf}

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    ${If} $InstallScope == "all"
        WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
    ${Else}
        WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
    ${EndIf}

    FileOpen $0 "$INSTDIR\${INSTALL_SCOPE_MARKER}" w
    FileWrite $0 "$InstallScope"
    FileClose $0
FunctionEnd

Function un.ApplyShellContext
    ${If} $un.InstallScope == "all"
        SetShellVarContext all
    ${Else}
        SetShellVarContext current
    ${EndIf}
FunctionEnd

Function un.DeleteScopedUninstaller
    SetRegView 64
    ${If} $un.InstallScope == "all"
        DeleteRegKey HKLM "${UNINST_KEY}"
    ${Else}
        DeleteRegKey HKCU "${UNINST_KEY}"
    ${EndIf}
FunctionEnd

Function un.onInit
    StrCpy $un.InstallScope "current"

    IfFileExists "$INSTDIR\${INSTALL_SCOPE_MARKER}" 0 detectFromRegistry
        FileOpen $0 "$INSTDIR\${INSTALL_SCOPE_MARKER}" r
        FileRead $0 $1
        FileClose $0
        ${If} $1 == "all"
            StrCpy $un.InstallScope "all"
        ${EndIf}
        Goto applyContext

    detectFromRegistry:
        SetRegView 64
        ReadRegStr $0 HKLM "${UNINST_KEY}" "InstallLocation"
        ${If} $0 == $INSTDIR
            StrCpy $un.InstallScope "all"
            Goto applyContext
        ${EndIf}

        ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
        ${If} $0 == $INSTDIR
            StrCpy $un.InstallScope "current"
        ${EndIf}

    applyContext:
        Call un.ApplyShellContext
FunctionEnd

Function .onInit
    StrCpy $AutoLaunch "1"
    StrCpy $InstallScope ""
    StrCpy $R5 "0"
    IfSilent silentMode parseArguments
    silentMode:
        StrCpy $AutoLaunch "0"

    parseArguments:
        ${GetParameters} $R0
        ClearErrors
        ${GetOptions} $R0 "/AUTOLAUNCH=" $R1
        ${IfNot} ${Errors}
            StrCpy $AutoLaunch $R1
        ${EndIf}

        ClearErrors
        ${GetOptions} $R0 "/ALLUSERS=" $R1
        ${IfNot} ${Errors}
            ${If} $R1 == "1"
                StrCpy $InstallScope "all"
            ${EndIf}
        ${EndIf}

        ClearErrors
        ${GetOptions} $R0 "/CURRENTUSER=" $R1
        ${IfNot} ${Errors}
            ${If} $R1 == "1"
                ${If} $InstallScope == "all"
                    IfSilent invalidScopeSwitch invalidScopeSwitchInteractive
                    invalidScopeSwitch:
                        SetErrorLevel 87
                        Abort
                    invalidScopeSwitchInteractive:
                        MessageBox MB_ICONSTOP|MB_OK "Use either /ALLUSERS=1 or /CURRENTUSER=1, not both."
                        Abort
                ${EndIf}
                StrCpy $InstallScope "current"
            ${EndIf}
        ${EndIf}

        ClearErrors
        ${GetOptions} $R0 "/ELEVATED=" $R1
        ${IfNot} ${Errors}
            ${If} $R1 == "1"
                StrCpy $R5 "1"
            ${EndIf}
        ${EndIf}

        !insertmacro wails.checkArchitecture

        SetRegView 64
        Call SelectInstallScope
        Call EnsureInstallElevation

        IfSilent continueInstall checkExistingInstall

    checkExistingInstall:
        IfFileExists "$INSTDIR\${PRODUCT_EXECUTABLE}" promptReplace continueInstall

    promptReplace:
        MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
            "${INFO_PRODUCTNAME} is already installed in:$\r$\n$INSTDIR$\r$\n$\r$\nReplace the existing installation?" \
            IDYES continueInstall
        Abort

    continueInstall:
FunctionEnd

Section
    Call ApplyShellContext
    !insertmacro wails.webview2runtime

    SetOverwrite on
    SetOutPath $INSTDIR
    !insertmacro wails.files

    SetOutPath "$INSTDIR\runtime"
    File /r "${SYNAPSE_RUNTIME_STAGE}\*"

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols
    Call WriteScopedUninstaller

    ${If} $AutoLaunch == "1"
        ExecShell "" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    ${EndIf}
SectionEnd

Section "uninstall"
    Call un.ApplyShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}"
    Delete "$INSTDIR\${INSTALL_SCOPE_MARKER}"
    RMDir /r "$INSTDIR"

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols
    Call un.DeleteScopedUninstaller
SectionEnd
