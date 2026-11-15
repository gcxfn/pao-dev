!include "LogicLib.nsh"

# PAO_HOME 位于 $INSTDIR\data。electron-builder 默认在升级和卸载时删除整个
# $INSTDIR，因此这里只清理其余直接子项。NSIS 的 StrCmp 不区分大小写，
# 与 Windows 路径语义一致。
!macro customRemoveFiles
  !define PAO_REMOVE_UNIQUE_ID ${__LINE__}

  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  # 旧版允许 PAO_HOME 直接位于 EXE 同层。三项 marker 任一存在时，
  # 无法安全区分旧数据与应用文件，因此升级和卸载都必须停止。
  IfFileExists "$INSTDIR\部门" pao_remove_legacy_home_${PAO_REMOVE_UNIQUE_ID}
  IfFileExists "$INSTDIR\工作流" pao_remove_legacy_home_${PAO_REMOVE_UNIQUE_ID}
  IfFileExists "$INSTDIR\pao配置" pao_remove_legacy_home_${PAO_REMOVE_UNIQUE_ID}

  InitPluginsDir
  SetOutPath $TEMP

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    StrCpy $R3 "0"
  ${endif}

  FindFirst $R1 $R2 "$INSTDIR\*.*"

  pao_remove_loop_${PAO_REMOVE_UNIQUE_ID}:
    StrCmp "$R2" "" pao_remove_done_${PAO_REMOVE_UNIQUE_ID}
    StrCmp "$R2" "." pao_remove_next_${PAO_REMOVE_UNIQUE_ID}
    StrCmp "$R2" ".." pao_remove_next_${PAO_REMOVE_UNIQUE_ID}
    StrCmp "$R2" "data" pao_remove_next_${PAO_REMOVE_UNIQUE_ID}

    IfFileExists "$INSTDIR\$R2\*.*" \
      pao_remove_directory_${PAO_REMOVE_UNIQUE_ID} \
      pao_remove_file_${PAO_REMOVE_UNIQUE_ID}

  pao_remove_directory_${PAO_REMOVE_UNIQUE_ID}:
    ${if} ${isUpdated}
      # atomicRMDir 会递归移动目录内容。先创建对应的备份目录，
      # 这样空的顶层目录也能在失败时恢复。
      CreateDirectory "$PLUGINSDIR\old-install\$R2"
      Push "\$R2"
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        StrCpy $R4 $R0
        FindClose $R1
        Push ""
        Call un.restoreFiles
        Pop $R0
        SetErrorLevel 2
        Abort "PAO 升级无法移动 $R4，已恢复原安装目录。"
      ${endif}

      RMDir /r "$INSTDIR\$R2"
    ${else}
      RMDir /r "$INSTDIR\$R2"
    ${endif}
    Goto pao_remove_next_${PAO_REMOVE_UNIQUE_ID}

  pao_remove_file_${PAO_REMOVE_UNIQUE_ID}:
    ${if} ${isUpdated}
      # 卸载器正在 $INSTDIR 内运行，无法改名。先只记录，等其余文件
      # 全部移动成功后再安排删除；升级失败回滚时旧卸载器必须仍然存在。
      StrCmp "$R2" "${UNINSTALL_FILENAME}" \
        pao_remove_uninstaller_${PAO_REMOVE_UNIQUE_ID} \
        pao_remove_move_file_${PAO_REMOVE_UNIQUE_ID}

      pao_remove_move_file_${PAO_REMOVE_UNIQUE_ID}:
        # Rename 也能移动空目录；空目录没有子项，IfFileExists 会像普通文件一样
        # 走到这个分支。
        ClearErrors
        Rename "$INSTDIR\$R2" "$PLUGINSDIR\old-install\$R2"
        ${if} ${Errors}
          FindClose $R1
          Push ""
          Call un.restoreFiles
          Pop $R0
          SetErrorLevel 2
          Abort "PAO 升级无法移动 $INSTDIR\$R2，已恢复原安装目录。"
        ${endif}
        Goto pao_remove_next_${PAO_REMOVE_UNIQUE_ID}

      pao_remove_uninstaller_${PAO_REMOVE_UNIQUE_ID}:
        StrCpy $R3 "1"
        Goto pao_remove_next_${PAO_REMOVE_UNIQUE_ID}
    ${else}
      Delete "$INSTDIR\$R2"
      # Delete 处理普通文件，RMDir 处理空目录。
      RMDir "$INSTDIR\$R2"
    ${endif}

  pao_remove_next_${PAO_REMOVE_UNIQUE_ID}:
    FindNext $R1 $R2
    Goto pao_remove_loop_${PAO_REMOVE_UNIQUE_ID}

  pao_remove_done_${PAO_REMOVE_UNIQUE_ID}:
    FindClose $R1
    ${if} ${isUpdated}
      ${if} $R3 == "1"
        # 所有需要回滚保护的文件都已移动成功，退出时再让 NSIS 删除旧卸载器。
        Delete "$INSTDIR\${UNINSTALL_FILENAME}"
      ${endif}
    ${endif}
    Goto pao_remove_return_${PAO_REMOVE_UNIQUE_ID}

  pao_remove_legacy_home_${PAO_REMOVE_UNIQUE_ID}:
    SetErrorLevel 2
    Abort "检测到 EXE 同层的 PAO 旧数据，升级/卸载已停止。请先将旧数据迁移到 data 或独立 PAO_HOME 后再操作。"

  pao_remove_return_${PAO_REMOVE_UNIQUE_ID}:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0

  !undef PAO_REMOVE_UNIQUE_ID
!macroend
