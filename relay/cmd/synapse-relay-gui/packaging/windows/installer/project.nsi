Unicode true

####
## Custom Synapse Relay Windows installer
####
## Supports:
## - one-click interactive install with no wizard pages
## - silent install via /S
## - optional silent auto-launch via /AUTOLAUNCH=1
## - install-time unpack of bundled runtimes next to the app
####

!define PRODUCT_EXECUTABLE "synapse-relay-gui.exe"

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

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Icon "..\icon.ico"
UninstallIcon "..\icon.ico"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"
InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
ShowInstDetails nevershow
AutoCloseWindow true
SilentInstall normal
SilentUnInstall normal

Page instfiles
UninstPage instfiles

Var AutoLaunch

Function .onInit
    StrCpy $AutoLaunch "1"
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

        !insertmacro wails.checkArchitecture

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
    !insertmacro wails.setShellContext
    !insertmacro wails.webview2runtime

    SetOverwrite on
    SetOutPath $INSTDIR
    !insertmacro wails.files

    SetOutPath "$INSTDIR\runtime"
    File /r "..\runtime\*"

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols
    !insertmacro wails.writeUninstaller

    WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"

    ${If} $AutoLaunch == "1"
        ExecShell "" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    ${EndIf}
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}"
    RMDir /r "$INSTDIR"

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols
    !insertmacro wails.deleteUninstaller
SectionEnd
