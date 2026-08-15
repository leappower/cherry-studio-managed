# ============================================================
# 配置CherryStudio服务端.ps1  →  安装后重命名 index 头注释（实际文件名 configure-server.ps1）
# =====================================================================
# configure-server.ps1  —  CherryStudio 受管版 Sidecar 服务端地址配置工具
# 批次H B+A+E+F
#   B+A+E : 默认填服务端地址(192.168.3.181) + 可手动改 + "扫描局域网"按钮自动定位
#   F     : 装完可重跑本工具，服务端 IP 变了可重新扫描 / 手动改，改完即生效
# 依赖   : 同目录 sidecar.exe（discover / set-server 命令）
# 用法   : 双击“配置CherryStudio服务端.bat”；或命令行
#          powershell -ExecutionPolicy Bypass -File configure-server.ps1
#         -Auto : 安装时自动调用，若当前已配置有效地址则直接继续（不阻塞安装）
# ============================================================
param([switch]$Auto)

$ErrorActionPreference = "Stop"
# sidecar.exe 与 ps1 同目录（$INSTDIR\resources\sidecar\，由 electron-builder extraResources 打包）
$script:SidecarExe = Join-Path $PSScriptRoot "sidecar.exe"
if (-not (Test-Path $script:SidecarExe)) {
    # 兼容：工具被复制到其他位置时，自动向上找 resources\sidecar\sidecar.exe
    $candidate = $PSScriptRoot
    for ($i = 0; $i -lt 4; $i++) {
        $candidate = Split-Path $candidate -Parent
        $t = Join-Path $candidate "resources\sidecar\sidecar.exe"
        if (Test-Path $t) { $script:SidecarExe = $t; break }
    }
}

if (-not (Test-Path $script:SidecarExe)) {
    [System.Windows.Forms.MessageBox]::Show(
        "未找到 sidecar.exe（$script:SidecarExe）。`n请确认本工具位于 CherryStudio 安装目录内。",
        "CherryStudio 受管版", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------- 读取当前配置里的服务端地址 ----------
function Get-CurrentServerUrl {
    $userCfg = Join-Path $env:ProgramData "CherryManaged\config.json"
    $url = ""
    if (Test-Path $userCfg) {
        try {
            $cfg = Get-Content $userCfg -Raw -Encoding UTF8 | ConvertFrom-Json
            $url = $cfg.server.url
        } catch { $url = "" }
    }
    return $url
}

# ---------- 扫描局域网找服务端（调 sidecar discover）----------
function Invoke-ScanLan {
    param([string]$Current)
    $result = @()
    try {
        $out = & $script:SidecarExe discover 2>&1
        $lines = @($out | ForEach-Object { "$_" })
        foreach ($line in $lines) {
            $line = $line.Trim()
            if ($line -match "^\d{1,3}(\.\d{1,3}){3}:\d+$") {
                $result += $line
            }
        }
    } catch {
        # discover 失败则保持当前，不报错（安装不中断）
    }
    if ($result.Count -eq 0 -and $Current) { $result += $Current }
    return ($result | Select-Object -Unique)
}

# ---------- 写服务端地址（调 sidecar set-server）----------
function Set-ServerAddress {
    param([string]$IpPort)
    $parts = $IpPort.Split(":")
    $ip = $parts[0]
    $port = if ($parts.Count -gt 1) { $parts[1] } else { "2334" }
    try {
        & $script:SidecarExe set-server --ip $ip --port $port 2>&1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# ---------- 组装窗口 ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = "CherryStudio 受管版 - 配置服务端地址"
$form.Size = New-Object System.Drawing.Size(520, 340)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "请确认 CherryStudio 服务端地址（员工机将连接此服务端）"
$lblTitle.Location = New-Object System.Drawing.Point(20, 18)
$lblTitle.AutoSize = $true
$lblTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($lblTitle)

# 默认地址
$defaultAddr = "192.168.3.181:2334"
$current = Get-CurrentServerUrl
if ($current -match "ws://([^/]+)/ws") { $defaultAddr = $Matches[1] }

$lblAddr = New-Object System.Windows.Forms.Label
$lblAddr.Text = "服务端 IP:端口"
$lblAddr.Location = New-Object System.Drawing.Point(20, 60)
$lblAddr.AutoSize = $true
$form.Controls.Add($lblAddr)

$txtAddr = New-Object System.Windows.Forms.TextBox
$txtAddr.Text = $defaultAddr
$txtAddr.Location = New-Object System.Drawing.Point(130, 57)
$txtAddr.Size = New-Object System.Drawing.Size(220, 24)
$form.Controls.Add($txtAddr)

# 扫描按钮
$btnScan = New-Object System.Windows.Forms.Button
$btnScan.Text = "扫描局域网"
$btnScan.Location = New-Object System.Drawing.Point(360, 55)
$btnScan.Size = New-Object System.Drawing.Size(120, 30)
$form.Controls.Add($btnScan)

# 扫描结果列表
$lblScan = New-Object System.Windows.Forms.Label
$lblScan.Text = "扫描到的服务端（选中即填入上方）："
$lblScan.Location = New-Object System.Drawing.Point(20, 100)
$lblScan.AutoSize = $true
$form.Controls.Add($lblScan)

$lstScan = New-Object System.Windows.Forms.ListBox
$lstScan.Location = New-Object System.Drawing.Point(20, 128)
$lstScan.Size = New-Object System.Drawing.Size(460, 110)
$form.Controls.Add($lstScan)

# 按钮
$btnOK = New-Object System.Windows.Forms.Button
$btnOK.Text = "确认并保存"
$btnOK.Location = New-Object System.Drawing.Point(150, 255)
$btnOK.Size = New-Object System.Drawing.Size(110, 32)
$btnOK.DialogResult = "OK"
$form.Controls.Add($btnOK)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "取消"
$btnCancel.Location = New-Object System.Drawing.Point(280, 255)
$btnCancel.Size = New-Object System.Drawing.Size(80, 32)
$btnCancel.DialogResult = "Cancel"
$form.Controls.Add($btnCancel)

$btnScan.Add_Click({
    $btnScan.Enabled = $false
    $btnScan.Text = "扫描中..."
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    [System.Windows.Forms.Application]::DoEvents()
    try {
        $found = Invoke-ScanLan -Current $txtAddr.Text.Trim()
        $lstScan.Items.Clear()
        foreach ($f in $found) { [void]$lstScan.Items.Add($f) }
        if ($found.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show(
                "局域网内未扫描到受管服务端。`n请确认服务端已在 192.168.3.181 或其它机器上启动，`n或手动在上方输入服务端 IP:端口。",
                "扫描结果", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
    } finally {
        $form.Cursor = [System.Windows.Forms.Cursors]::Default
        $btnScan.Enabled = $true
        $btnScan.Text = "扫描局域网"
    }
})

$lstScan.Add_SelectedIndexChanged({
    if ($lstScan.SelectedItem) { $txtAddr.Text = $lstScan.SelectedItem.ToString() }
})

$form.Add_Shown({
    # 首次打开自动扫一次（非阻塞安装：失败静默，用户可手动）
    if (-not $Auto) {
        $btnScan.PerformClick()
    }
})

$result = $form.ShowDialog()
if ($result -eq "OK") {
    $addr = $txtAddr.Text.Trim()
    if ($addr -notmatch "^\d{1,3}(\.\d{1,3}){3}(:\d+)?$" -and $addr -notmatch "^[A-Za-z0-9.\-]+(:\d+)?$") {
        [System.Windows.Forms.MessageBox]::Show("服务端地址格式不正确：$addr", "错误",
            [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 3
    }
    if ($addr -notmatch ":\d+$") { $addr = "$addr`:2334" }
    if (Set-ServerAddress $addr) {
        [System.Windows.Forms.MessageBox]::Show(
            "服务端地址已更新为：$addr`n`n请重启 CherryStudio（或重启 CherrySidecar 服务）使其生效。",
            "配置成功", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        exit 0
    } else {
        [System.Windows.Forms.MessageBox]::Show("写入服务端地址失败，请检查权限后重试。", "错误",
            [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }
}
exit 0
