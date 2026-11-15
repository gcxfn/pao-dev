Unicode true
Name "PAO NSIS 数据保留隔离测试"
OutFile "D:\AI\workspace\临时文件夹\安装数据目录-20261020\20261020-170557-746-0f0af67d\work\pao-nsis-data-test.exe"
InstallDir "D:\AI\workspace\临时文件夹\安装数据目录-20261020\20261020-170557-746-0f0af67d\work\install-fixture"
RequestExecutionLevel user

!include LogicLib.nsh
!addplugindir /x86-unicode "C:\Users\ASUS\AppData\Local\electron-builder\Cache\nsis-resources-3.4.1\nsis-resources-3.4.1-2jx2y\plugins\x86-unicode"
!include "D:\AI\workspace\pao-dev\desktop\node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh"

!define PRODUCT_FILENAME "PAO"
!define UNINSTALL_FILENAME "Uninstall PAO.exe"

!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`

!include "D:\AI\workspace\pao-dev\desktop\apps\desktop\resources\installer.nsh"

Function un.atomicRMDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "$INSTDIR$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "$PLUGINSDIR\old-install$R0\$R2"

      Push "$R0\$R2"
      Call un.atomicRMDir
      Pop $R3

      ${if} $R3 != 0
        Goto done
      ${endIf}

      Goto continue

    isNotDir:
      ClearErrors
      Rename "$INSTDIR$R0\$R2" "$PLUGINSDIR\old-install$R0\$R2"

      # Ignore errors when renaming ourselves.
      StrCmp "$R0\$R2" "${UNINSTALL_FILENAME}" 0 +2
      ClearErrors

      IfErrors 0 +3
      StrCpy $R3 "$INSTDIR$R0\$R2"
      Goto done

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R3 0

  done:
    FindClose $R1

    StrCpy $R0 $R3

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.restoreFiles
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "$PLUGINSDIR\old-install$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "$INSTDIR$R0\$R2"

      Push "$R0\$R2"
      Call un.restoreFiles
      Pop $R3

      Goto continue

    isNotDir:
      Rename "$PLUGINSDIR\old-install$R0\$R2" "$INSTDIR$R0\$R2"

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R0 0
    FindClose $R1

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd



Section "Install"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"
SectionEnd

Section "Uninstall"
  !insertmacro customRemoveFiles
SectionEnd