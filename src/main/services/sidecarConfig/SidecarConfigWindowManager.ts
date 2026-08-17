import { join } from 'node:path'

import { loggerService } from '@logger'
import { isDev } from '@main/core/platform'
import { BrowserWindow } from 'electron'

const logger = loggerService.withContext('SidecarConfigWindowManager')

/**
 * 受管版 sidecar 服务端地址配置窗（批次H-2）。
 *
 * 独立 BrowserWindow（不走 WindowManager 主系统，学 Migration 独立窗口范式）：
 * 只在受管版首次运行且未配置服务端地址时由 ManagedSidecarService 触发。
 * 窗口让用户填写服务端 `IP:端口`、扫描局域网、保存（经 IPC 调 sidecar.exe）。
 *
 * 安全：独立页面无特权，仅通过 `window.electron.ipcRenderer.invoke` 调
 * 受控的 SidecarConfig IPC 通道（读地址/扫描/write）。不关 webSecurity。
 */
export class SidecarConfigWindowManager {
  private window: BrowserWindow | null = null
  /** 已注册的 IPC handler（避免重复注册）。 */
  private ipcRegistered = false
  /** 注册/注销 IPC handler（由 ManagedSidecarService 传入，含 close 决策）。 */
  private ipcRegister?: () => void
  private ipcUnregister?: () => void

  hasWindow(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  getWindow(): BrowserWindow | null {
    return this.window
  }

  /** 设置 IPC handler 注册/注销器。 */
  registerIpc(register: () => void, unregister: () => void): void {
    this.ipcRegister = register
    this.ipcUnregister = unregister
  }

  private ensureIpc(): void {
    if (!this.ipcRegistered) {
      this.ipcRegister?.()
      this.ipcRegistered = true
    }
  }

  private releaseIpc(): void {
    if (this.ipcRegistered) {
      this.ipcUnregister?.()
      this.ipcRegistered = false
    }
  }

  /** 创建并显示配置窗（幂等：已存在则聚焦）。 */
  open(): BrowserWindow {
    if (this.hasWindow()) {
      this.window!.show()
      this.window!.focus()
      return this.window!
    }

    this.ensureIpc()

    logger.info('Opening sidecar config window (managed first-run)')
    this.window = new BrowserWindow({
      width: 560,
      height: 420,
      minWidth: 520,
      minHeight: 380,
      resizable: false,
      maximizable: false,
      minimizable: false,
      autoHideMenuBar: true,
      title: '配置 CherryStudio 服务端',
      show: false,
      webPreferences: {
        // 独立受控窗口：仅 preload 暴露的 ipcRenderer.invoke 可用。
        preload: join(__dirname, '../preload/simplest.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.window.on('closed', () => {
      this.window = null
      // 窗口关闭即注销 IPC handler，避免重复注册抛错 / handler 残留。
      this.releaseIpc()
      logger.info('Sidecar config window closed')
    })

    // Load the config window.
    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      void this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/windows/sidecarConfig/index.html`)
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/windows/sidecarConfig/index.html'))
    }

    this.window.once('ready-to-show', () => {
      this.window?.show()
    })

    return this.window
  }

  /** 关闭配置窗（用户在窗口内点"完成"后调用）。 */
  close(): void {
    if (this.hasWindow()) {
      this.window!.close()
    }
  }

  /** 应用退出时清理（注销 IPC handler）。 */
  dispose(): void {
    this.releaseIpc()
    if (this.hasWindow()) {
      this.window!.destroy()
      this.window = null
    }
  }
}
