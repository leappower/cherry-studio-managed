import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

const execFileAsync = promisify(execFile)

const logger = loggerService.withContext('SidecarConfigIpcHandler')

/**
 * 读取受管版 sidecar 用户级配置中的服务端地址。
 * 路径对齐 sidecar.py `_user_config_dir()`：Windows 用 %APPDATA%\CherryManaged\config.json。
 * 返回 `server.url`（形如 ws://IP:PORT/ws）或空串（未配置/读取失败）。
 */
export async function readManagedServerUrl(): Promise<string> {
  try {
    // Must match where sidecar cmd_set_server writes the user config.
    // Since 2026-08-17 the sidecar writes to %APPDATA%\CherryManaged (not
    // %PROGRAMDATA%) to fix the write-permission bug; reading here from
    // ProgramData instead produced a read/write path mismatch that kept
    // re-opening the config dialog (save wrote APPDATA, read looked at
    // ProgramData -> empty -> dialog loop).
    const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? 'C:', 'AppData', 'Roaming')
    const cfgPath = join(appData, 'CherryManaged', 'config.json')
    const raw = await readFile(cfgPath, 'utf-8')
    const cfg = JSON.parse(raw) as { server?: { url?: string } }
    return cfg.server?.url ?? ''
  } catch {
    return ''
  }
}

/** 解析 `server.url` 形如 `ws://IP:PORT/ws` 为 `IP:PORT`；失败返回空。 */
function urlToIpPort(url: string): string {
  const m = /^ws:\/\/([^/]+)\/ws$/.exec(url.trim())
  return m ? m[1] : ''
}

/**
 * 调 `sidecar.exe discover` 扫描局域网服务端，返回 `IP:port` 列表。
 * discover 逐行打印 `IP:port`（后跟一行 JSON），无结果打印 `no-server-found`。
 */
async function scanLan(sidecarExe: string): Promise<string[]> {
  const results: string[] = []
  try {
    const { stdout } = await execFileAsync(sidecarExe, ['discover'], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    })
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim()
      if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(t)) {
        results.push(t)
      }
    }
  } catch (err) {
    logger.warn('sidecar discover failed (scan may be empty)', err as Error)
  }
  return [...new Set(results)]
}

/** 调 `sidecar.exe set-server --ip X --port Y` 写回服务端地址。 */
async function setServer(sidecarExe: string, ipPort: string): Promise<boolean> {
  const [ip, port] = splitIpPort(ipPort)
  try {
    await execFileAsync(sidecarExe, ['set-server', '--ip', ip, '--port', port], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    })
    return true
  } catch (err) {
    logger.error('sidecar set-server failed', err as Error)
    return false
  }
}

function splitIpPort(ipPort: string): [string, string] {
  const idx = ipPort.lastIndexOf(':')
  if (idx === -1) return [ipPort.trim(), '2334']
  return [ipPort.slice(0, idx).trim(), ipPort.slice(idx + 1).trim() || '2334']
}

/**
 * 注册 SidecarConfig 窗口的 IPC handler。
 * 在 ManagedSidecarService 触发配置窗时调用；重复注册前需先 cache 注销。
 *
 * @param getSidecarExe 返回 sidecar.exe 绝对路径（null 表示不可用）
 * @param onClose 配置窗关闭回调，参数 saveSuccess=true 表示用户已保存成功（用于重跑服务自愈）
 */
export function registerSidecarConfigIpcHandlers(
  getSidecarExe: () => string | null,
  onClose?: (saveSuccess: boolean) => void
): void {
  ipcMain.handle(IpcChannel.SidecarConfig_GetServerUrl, async (): Promise<string> => {
    const url = await readManagedServerUrl()
    return urlToIpPort(url)
  })

  ipcMain.handle(IpcChannel.SidecarConfig_ScanLan, async (): Promise<string[]> => {
    const exe = getSidecarExe()
    if (!exe) return []
    return scanLan(exe)
  })

  ipcMain.handle(IpcChannel.SidecarConfig_SetServer, async (_e, ipPort: unknown): Promise<boolean> => {
    const exe = getSidecarExe()
    if (!exe || typeof ipPort !== 'string') return false
    const ok = await setServer(exe, ipPort)
    if (ok) logger.info('sidecar server address updated', { ipPort })
    return ok
  })

  // Close 通道 → 关闭配置窗（renderer 保存成功后调用；saveSuccess 供 main 决定是否重跑自愈）。
  ipcMain.handle(IpcChannel.SidecarConfig_Close, (_e, saveSuccess: unknown): void => {
    onClose?.(saveSuccess === true)
  })
}

export function unregisterSidecarConfigIpcHandlers(): void {
  ipcMain.removeHandler(IpcChannel.SidecarConfig_GetServerUrl)
  ipcMain.removeHandler(IpcChannel.SidecarConfig_ScanLan)
  ipcMain.removeHandler(IpcChannel.SidecarConfig_SetServer)
  ipcMain.removeHandler(IpcChannel.SidecarConfig_Close)
}
