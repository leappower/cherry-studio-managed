;Inspired by:
; https://gist.github.com/bogdibota/062919938e1ed388b3db5ea31f52955c
; https://stackoverflow.com/questions/34177547/detect-if-visual-c-redistributable-for-visual-studio-2013-is-installed
; https://stackoverflow.com/a/54391388
; https://github.com/GitCommons/cpp-redist-nsis/blob/main/installer.nsh

;Find latests downloads here:
; https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

!include LogicLib.nsh
!include x64.nsh
!include FileFunc.nsh

; ------------------------------------------------------------
; 受管版（Fork）vs 官方版编译期开关
; ------------------------------------------------------------
; MANAGED_BUILD=1（构建环境变量，fork-win-build.yml 设置）→ 启用受管集成
; （Sidecar 服务 + 受管标记 + 局域网访问配置）。官方版构建不设该变量 → 以下
; 所有受管专属逻辑（含管理员要求）全部跳过，不影响官方安装器行为。
; ⚠️ 为什么用 ${env:MANAGED_BUILD} 而非 electron-builder define：
;    electron-builder 的 NSIS define 是固定列表、不支持自定义 define，
;    !ifdef MANAGED_BUILD 永远不生效。改用 NSIS 原生编译期环境变量。
!ifndef MANAGED_BUILD
  !define MANAGED_BUILD "${env:MANAGED_BUILD}"
!endif

; https://github.com/electron-userland/electron-builder/issues/1122
!ifndef BUILD_UNINSTALLER
  ; Check VC++ Redistributable based on architecture stored in $1
  Function checkVCRedist
    ${If} $1 == "arm64"
      ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\ARM64" "Installed"
    ${Else}
      ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${EndIf}
  FunctionEnd

  Function checkArchitectureCompatibility
    ; Initialize variables
    StrCpy $0 "0"  ; Default to incompatible
    StrCpy $1 ""   ; System architecture
    StrCpy $3 ""   ; App architecture

    ; Check system architecture using built-in NSIS functions
    ${If} ${RunningX64}
      ; Check if it's ARM64 by looking at processor architecture
      ReadEnvStr $2 "PROCESSOR_ARCHITECTURE"
      ReadEnvStr $4 "PROCESSOR_ARCHITEW6432"

      ${If} $2 == "ARM64"
      ${OrIf} $4 == "ARM64"
        StrCpy $1 "arm64"
      ${Else}
        StrCpy $1 "x64"
      ${EndIf}
    ${Else}
      StrCpy $1 "x86"
    ${EndIf}

    ; Determine app architecture based on build variables
    !ifdef APP_ARM64_NAME
      !ifndef APP_64_NAME
        StrCpy $3 "arm64"  ; App is ARM64 only
      !endif
    !endif
    !ifdef APP_64_NAME
      !ifndef APP_ARM64_NAME
        StrCpy $3 "x64"    ; App is x64 only
      !endif
    !endif
    !ifdef APP_64_NAME
      !ifdef APP_ARM64_NAME
        StrCpy $3 "universal"  ; Both architectures available
      !endif
    !endif

    ; If no architecture variables are defined, assume x64
    ${If} $3 == ""
      StrCpy $3 "x64"
    ${EndIf}

    ; Compare system and app architectures
    ${If} $3 == "universal"
      ; Universal build, compatible with all architectures
      StrCpy $0 "1"
    ${ElseIf} $1 == $3
      ; Architectures match
      StrCpy $0 "1"
    ${Else}
      ; Architectures don't match
      StrCpy $0 "0"
    ${EndIf}
  FunctionEnd
!endif

!macro customInit
  ; 受管版强制要求管理员安装：非管理员直接弹警告并中止安装。
  ; 理由：受管版安装需配防火墙放行局域网访问（netsh 需管理员），且要注册
  ; sidecar 服务；非管理员装出来是“半残状态”（CherryStudio 能跑但局域网连
  ; 不上），小白用户不会排查。宁可装不了明确提示，也绝不留下半残状态。
  ; 官方版不要求管理员，保持原样。
  !if "${MANAGED_BUILD}" == "1"
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 != "admin"
      MessageBox MB_ICONSTOP|MB_OK "CherryStudio 受管版需要管理员权限才能正确安装。$\r$\n$\r$\n请关闭此窗口，右键安装程序选择“以管理员身份运行”后重试。"
      Abort
    ${EndIf}
  !endif

  ; If a per-machine (all users) installation exists, ensure we have admin privileges.
  ; Without elevation, the installer cannot close the running app or manage the
  ; per-machine installation, causing "cannot close app" errors during both
  ; silent updates and manual reinstalls.
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
  ${If} $R0 != ""
    UserInfo::GetAccountType
    Pop $R1
    ${If} $R1 != "admin"
      ${GetParameters} $R2
      ExecShell "runas" "$EXEPATH" "$R2"
      ${If} ${Errors}
        SetErrorLevel 1
      ${Else}
        SetErrorLevel 0
      ${EndIf}
      Quit
    ${EndIf}
  ${EndIf}

  Push $0
  Push $1
  Push $2
  Push $3
  Push $4

  ; Check architecture compatibility first
  Call checkArchitectureCompatibility
  ${If} $0 != "1"
    MessageBox MB_ICONEXCLAMATION "\
      Architecture Mismatch$\r$\n$\r$\n\
      This installer is not compatible with your system architecture.$\r$\n\
      Your system: $1$\r$\n\
      App architecture: $3$\r$\n$\r$\n\
      Please download the correct version from:$\r$\n\
      https://www.cherry-ai.com/"
    ExecShell "open" "https://www.cherry-ai.com/"
    Abort
  ${EndIf}

  Call checkVCRedist
  ${If} $0 != "1"
    ; VC++ is required - install automatically since declining would abort anyway
    ; Select download URL based on system architecture (stored in $1)
    ${If} $1 == "arm64"
      StrCpy $2 "https://aka.ms/vs/17/release/vc_redist.arm64.exe"
      StrCpy $3 "$TEMP\vc_redist.arm64.exe"
    ${Else}
      StrCpy $2 "https://aka.ms/vs/17/release/vc_redist.x64.exe"
      StrCpy $3 "$TEMP\vc_redist.x64.exe"
    ${EndIf}

    inetc::get /CAPTION " " /BANNER "Downloading Microsoft Visual C++ Redistributable..." \
      $2 $3 /END
    Pop $0  ; Get download status from inetc::get
    ${If} $0 != "OK"
      MessageBox MB_ICONSTOP|MB_YESNO "\
        Failed to download Microsoft Visual C++ Redistributable.$\r$\n$\r$\n\
        Error: $0$\r$\n$\r$\n\
        Would you like to open the download page in your browser?$\r$\n\
        $2" IDYES openDownloadUrl IDNO skipDownloadUrl
      openDownloadUrl:
        ExecShell "open" $2
      skipDownloadUrl:
      Abort
    ${EndIf}

    ExecWait "$3 /install /quiet /norestart"
    ; Note: vc_redist exit code is unreliable, verify via registry check instead

    Call checkVCRedist
    ${If} $0 != "1"
      MessageBox MB_ICONSTOP|MB_YESNO "\
        Microsoft Visual C++ Redistributable installation failed.$\r$\n$\r$\n\
        Would you like to open the download page in your browser?$\r$\n\
        $2$\r$\n$\r$\n\
        The installation of ${PRODUCT_NAME} cannot continue." IDYES openInstallUrl IDNO skipInstallUrl
      openInstallUrl:
        ExecShell "open" $2
      skipInstallUrl:
      Abort
    ${EndIf}
  ${EndIf}
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend

; ============================================================
; E-4 企业受管版集成（Managed Build）
; ------------------------------------------------------------
; 受管版开启方式（构建流水线 fork-win-build.yml 设置环境变量）：
;   MANAGED_BUILD=1 → 启用受管集成（Sidecar 服务 + 受管标记）
;
;   SIDECAR_SERVICE  → Sidecar 服务名（NSSM，默认 CherrySidecar，
;                      与 sidecar.py SERVICE_NAME 保持一致，勿改）
;   SIDECAR_EXE_NAME → Sidecar 可执行文件名（默认 sidecar.exe）
;
; ⚠️ 为什么用 ${env:MANAGED_BUILD} 而非 electron-builder define：
;   electron-builder 的 NSIS defines 是固定列表（APP_ID/UNINSTALL_APP_KEY/
;   PRODUCT_NAME 等），不支持自定义 define，因此原来“由构建流水线设置
;   MANAGED_BUILD define”的设想无法实现（!ifdef MANAGED_BUILD 永远不生效）。
;   改用 NSIS 原生编译期环境变量 ${env:MANAGED_BUILD}：构建时设置环境变量
;   MANAGED_BUILD=1 即编译进受管逻辑；官方版不设则为空 → !if 分支跳过。
;
; nssm.exe 由构建流水线（fork-win-build.yml）内置到
;   $INSTDIR\resources\sidecar\nssm.exe
; （sidecar.exe 与 nssm.exe 同级），sidecar.py _find_nssm() 通过
; sys.executable.parent 定位到同一目录。
;
; 官方版构建不设置 MANAGED_BUILD 环境变量，本段不生效，不影响官方安装器。
; ============================================================
!ifndef SIDECAR_SERVICE
  !define SIDECAR_SERVICE "CherrySidecar"
!endif
!ifndef SIDECAR_EXE_NAME
  !define SIDECAR_EXE_NAME "sidecar.exe"
!endif

; ------------------------------------------------------------
; E-4（批次 F）：局域网访问自动化 —— 开箱即用（无需手动配防火墙/转发）
; ------------------------------------------------------------
; 受管版 CherryStudio API 已改为监听 0.0.0.0:23333（全网卡，见
; src/main/features/apiGateway/server.ts 的受管版 host 默认值逻辑），因此
; 局域网机器可直接访问 23333，无需端口转发；也不再启用 iphlpsvc/portproxy
; （实测：portproxy 会把 0.0.0.0:23333 占住，挡住 CherryStudio 绑定
; 127.0.0.1:23333，导致 API 起不来 —— 是有害的，必须移除）。
; 这里只需保留一条防火墙入站放行规则，让局域网能进 23333。
;
; ⚠️ 为什么不再只放在 customInstall 里：
;    customInstall 依赖 customInit 提权成功；per-user 安装或提权链未走通时，
;    netsh 会被静默跳过。现在抽成独立宏 LANSetup，无条件调用，并自检管理员：
;    非管理员自动提权重跑；用 nsExec::Exec 捕获返回值，失败弹窗报错，绝不静默吞。
; ------------------------------------------------------------
!macro LANSetup
  ; 受管版才需配防火墙。运行时判断安装包是否带 sidecar（受管版 extraResources
  ; 必然打进 $INSTDIR\resources\sidecar\，官方版没有）；不再依赖编译期
  ; ${env:MANAGED_BUILD}（makensis 编译时不可靠，曾致受管逻辑被整体剔除）。
  ${IfNot} ${FileExists} "$INSTDIR\resources\sidecar\${SIDECAR_EXE_NAME}"
    Return
  ${EndIf}
  ; 确认管理员权限（per-user 安装也可能到这里，需提权）
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 != "admin"
      DetailPrint "LANSetup: 需要管理员权限，尝试提权重跑"
      ${GetParameters} $1
      ExecShell "runas" "$EXEPATH" "$1"
      ${If} ${Errors}
        MessageBox MB_ICONEXCLAMATION "CherryStudio 受管版需要管理员权限配置局域网访问。$\r$\n请右键安装程序选择“以管理员身份运行”后重试。"
      ${EndIf}
      Return
    ${EndIf}

    DetailPrint "Enabling LAN access: firewall allow inbound TCP 23333"
    ; 防火墙放行 23333 入站（先删旧再添，幂等）——CherryStudio API 监听全网卡，直连即可
    nsExec::Exec 'netsh advfirewall firewall delete rule name="CherryStudio API"'
    Pop $1
    nsExec::Exec 'netsh advfirewall firewall add rule name="CherryStudio API" dir=in action=allow protocol=TCP localport=23333'
    Pop $1
    ${If} $1 != 0
      DetailPrint "防火墙规则添加失败（code=$1）"
    ${EndIf}
    DetailPrint "LANSetup done"
!macroend

; 安装阶段：写入受管标记环境变量 CHERRY_MANAGED_BUILD=1（受管运行时应用启动读取），
; 并调用 sidecar first-run 完成首次初始化（落盘用户级 config + 生成 device_id +
; 注册并启动 NSSM 服务 CherrySidecar）—— 实现“装完即用”，无需任何手动步骤。
; ⚠️ first-run 依赖同目录 nssm.exe（构建流水线内置），缺失则服务注册失败。
!macro customInstall
  ; 受管版才写受管标记、注册 sidecar 服务；官方版无 sidecar 目录则跳过。
  ; 判断改为运行时 FileExists（受管版安装包必然带 resources\sidecar\，
  ; 不再依赖编译期 ${env:MANAGED_BUILD} 宏——该宏在 makensis 编译时不可靠）。
    ${If} ${FileExists} "$INSTDIR\resources\sidecar\${SIDECAR_EXE_NAME}"
    DetailPrint "Setting managed build marker CHERRY_MANAGED_BUILD=1"
    WriteRegStr HKCU "Environment" "CHERRY_MANAGED_BUILD" "1"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

    ; 批次H-2：服务端地址配置弹窗已迁移到 CherryStudio 应用首次运行时
    ; (ManagedSidecarService)。安装阶段不再弹窗——NSIS 安装器上下文弹
    ; PowerShell WinForms 不稳定，且首次运行时可获得更准确的"是否已配置"
    ; 判断。configure-server.ps1 保留为 F 配置工具（装完可手动重跑）。

    DetailPrint "Running sidecar first-run (init config + register ${SIDECAR_SERVICE} service)"
    nsExec::ExecToLog '"$INSTDIR\resources\sidecar\${SIDECAR_EXE_NAME}" first-run'

    ; A 方案兜底：生成一个双击即用的手动恢复 bat（管理员自提权 + 重跑 first-run）。
    ; 与 B 方案（首启自动补跑）融合：B 正常时无需用它；若 B 因杀软/权限/异常未生效，
    ; 用户可双击本 bat 手动完成注册，保证“装完即用”不卡死。
    ; 单行字符串 + $\r$\n 换行 + $" 转义引号（NSIS 不支持多行字符串）。
    FileOpen $9 "$INSTDIR\启动CherryStudio服务.bat" w
    FileWrite $9 '@echo off$\r$\n'
    FileWrite $9 'rem ===== CherryStudio 受管版 Sidecar 服务（手动兜底，方案A）=====$\r$\n'
    FileWrite $9 'rem 作用：注册并启动 CherrySidecar 服务。首次运行会弹 UAC + 杀毒授权窗，请点“允许”。$\r$\n'
    FileWrite $9 'rem 什么时候用：安装后局域网连不上 / sc query CherrySidecar 查不到时，双击本文件。$\r$\n'
    FileWrite $9 'rem 提示：若提示需要管理员权限，请右键本文件，选择“以管理员身份运行”。$\r$\n'
    FileWrite $9 'net session >nul 2>&1$\r$\n'
    FileWrite $9 'if %errorlevel% neq 0 ($\r$\n'
    FileWrite $9 '  echo [提示] 需要管理员权限。请关闭本窗口，右键本文件选“以管理员身份运行”。$\r$\n'
    FileWrite $9 '  pause$\r$\n'
    FileWrite $9 '  exit /b$\r$\n'
    FileWrite $9 ')$\r$\n'
    FileWrite $9 'echo 正在注册并启动 CherrySidecar 服务（方案A手动兜底）...$\r$\n'
    FileWrite $9 '"$INSTDIR\resources\sidecar\${SIDECAR_EXE_NAME}" first-run$\r$\n'
    FileWrite $9 'echo.$\r$\n'
    FileWrite $9 'echo 完成。请验证：sc query CherrySidecar$\r$\n'
    FileWrite $9 'pause$\r$\n'
    FileClose $9

    ; 批次H F：生成“配置CherryStudio服务端.bat” —— 双击重新扫描/改服务端 IP（F 可重配）
    ; 复用配置工具 ps1（与 sidecar.exe 同目录，electron-builder extraResources 打包）。
    FileOpen $8 "$INSTDIR\配置CherryStudio服务端.bat" w
    FileWrite $8 '@echo off$\r$\n'
    FileWrite $8 'rem ===== CherryStudio 服务端地址配置工具（批次H E/F）=====$\r$\n'
    FileWrite $8 'rem 作用：服务端 IP 变了时，双击本文件重新扫描 / 手动修改服务端地址，改完即生效。$\r$\n'
    FileWrite $8 'rem 提示：若提示需要管理员权限，请右键本文件选“以管理员身份运行”。$\r$\n'
    FileWrite $8 'net session >nul 2>&1$\r$\n'
    FileWrite $8 'if %errorlevel% neq 0 ($\r$\n'
    FileWrite $8 '  echo [提示] 需要管理员权限。请关闭本窗口，右键本文件选“以管理员身份运行”。$\r$\n'
    FileWrite $8 '  pause$\r$\n'
    FileWrite $8 '  exit /b$\r$\n'
    FileWrite $8 ')$\r$\n'
    FileWrite $8 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\sidecar\configure-server.ps1"$\r$\n'
    FileWrite $8 'echo.$\r$\n'
    FileWrite $8 'echo 配置完成。请重启 CherryStudio 使其生效。$\r$\n'
    FileWrite $8 'pause$\r$\n'
    FileClose $8

    !insertmacro LANSetup
  ${EndIf}

!macroend

; 卸载阶段：停止并移除 Sidecar 服务（NSSM），清理受管数据、受管标记与局域网转发规则
!macro customUnInstall
  ; 受管版才清理 sidecar 服务/数据/防火墙；官方版无 sidecar 目录则跳过。
  ; 运行时判断（不依赖编译期 ${env:MANAGED_BUILD} 宏）。
  ${If} ${FileExists} "$INSTDIR\resources\sidecar\${SIDECAR_EXE_NAME}"
    DetailPrint "Removing managed Sidecar service (${SIDECAR_SERVICE})"
    nsExec::ExecToLog 'net stop "${SIDECAR_SERVICE}"'
    nsExec::ExecToLog '"$INSTDIR\resources\sidecar\nssm.exe" stop "${SIDECAR_SERVICE}"'
    nsExec::ExecToLog '"$INSTDIR\resources\sidecar\nssm.exe" remove "${SIDECAR_SERVICE}" confirm'
    Delete "$INSTDIR\resources\sidecar\managed_registry.db"
    Delete "$INSTDIR\resources\sidecar\data\managed_registry.db"
    RMDir /r "$INSTDIR\resources\sidecar\data"
    Delete "$INSTDIR\启动CherryStudio服务.bat"
    Delete "$INSTDIR\配置CherryStudio服务端.bat"
    Delete "$INSTDIR\resources\sidecar\configure-server.ps1"
    DeleteRegValue HKCU "Environment" "CHERRY_MANAGED_BUILD"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

    ; 卸载时删除用户级配置目录 %APPDATA%\CherryManaged
    ; （set-server/首启配置所在，自 2026-08-17 起改存这里而非 ProgramData）
    ; 删掉后重装必重新触发服务端地址选择，满足「重装必重选」语义。
    ; 先强制结束 sidecar 进程并短暂等待（服务可能已停但进程句柄未释放），
    ; 避免 RMDir 因文件被占用而静默失败。
    DetailPrint "Removing user config dir %APPDATA%\\CherryManaged"
    nsExec::ExecToLog 'taskkill /F /IM sidecar.exe'
    nsExec::ExecToLog 'timeout /t 2 /nobreak >nul'
    RMDir /r "$APPDATA\CherryManaged"

    ; 卸载时清理防火墙放行规则（不留脏配置）。portproxy 不再创建，无需处理。
    DetailPrint "Cleaning up firewall rule"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CherryStudio API"'
  ${EndIf}
!macroend

