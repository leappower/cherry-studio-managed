import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { isWin } from '@main/core/platform'
import {
  readManagedServerUrl,
  registerSidecarConfigIpcHandlers,
  unregisterSidecarConfigIpcHandlers
} from '@main/services/sidecarConfig/SidecarConfigIpcHandler'
import { SidecarConfigWindowManager } from '@main/services/sidecarConfig/SidecarConfigWindowManager'

const execFileAsync = promisify(execFile)

const logger = loggerService.withContext('ManagedSidecarService')

/**
 * NSSM service name registered by `sidecar.exe first-run`. MUST match the
 * `SERVICE_NAME` constant in sidecar/sidecar.py and the NSIS
 * `SIDECAR_SERVICE` define — changing one without the others breaks the
 * managed install (service never registers / uninstall can't find it).
 */
const SIDECAR_SERVICE_NAME = 'CherrySidecar'
/** Name of the sidecar executable (kept in sync with NSIS SIDECAR_EXE_NAME). */
const SIDECAR_EXE_NAME = 'sidecar.exe'

/**
 * Managed-build sidecar auto-heal (fork A/B 融合 — plan B: first-launch auto
 * recovery with plan A retained as a manual fallback).
 *
 * Background: the NSIS installer already runs `sidecar.exe first-run` at install
 * time (registers the NSSM service `CherrySidecar` + writes per-user config). But
 * that step is fire-and-forget (`nsExec::ExecToLog` does not inspect the exit
 * code), so a first-run that fails — e.g. antivirus prompt, transient ACL hiccup,
 * or an older package — silently leaves the service unregistered. The app then
 * runs locally but LAN (sidecar forwarding to 127.0.0.1:23333) never works, with
 * no visible error.
 *
 * This service is the B-side auto-heal: on every launch of a *managed* build it
 * checks whether the service is actually registered, and if not, re-runs the
 * sidecar first-run automatically. It is idempotent (skips when registered) and
 * must never block or fail app startup. Plan A (manual) is retained: the user can
 * always run `sidecar.exe first-run` by hand, or use the `.bat` placed by the
 * installer, as a fallback if this auto-heal ever misbehaves.
 *
 * Official builds never take this path (no sidecar, no CHERRY_MANAGED_BUILD).
 */
@Injectable('ManagedSidecarService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['AppUpdaterService'])
export class ManagedSidecarService extends BaseService {
  /** 受管版首次运行的服务端地址配置窗（批次H-2）。 */
  private readonly configWindow = new SidecarConfigWindowManager()

  protected onReady(): void {
    if (!isWin) {
      return
    }
    // Fire-and-forget so the check never gates boot.
    void this.run().catch((err) => {
      logger.warn('managed sidecar auto-heal failed (non-fatal)', err as Error)
    })
  }

  private async run(): Promise<void> {
    if (!this.isManagedBuild()) {
      logger.debug('not a managed build, skip sidecar auto-heal')
      return
    }

    const sidecarExe = this.sidecarExePath()
    if (!sidecarExe) {
      logger.warn('managed build but sidecar.exe not found, skip auto-heal')
      return
    }

    // 批次H-2：受管版首启时，若尚未配置服务端地址则弹配置窗；已配置则走服务自愈。
    const currentUrl = await readManagedServerUrl()
    if (!currentUrl) {
      logger.info('managed build but server address not configured, opening config window')
      this.openConfigWindow()
      // 配置窗关前不阻塞主流程；服务自愈等用户保存后下次启动或重连再走。
      return
    }

    if (await this.serviceRegistered()) {
      logger.info(`sidecar service "${SIDECAR_SERVICE_NAME}" already registered, skip first-run`)
      return
    }

    logger.info(`sidecar service "${SIDECAR_SERVICE_NAME}" not registered, running first-run (auto-heal)`)
    try {
      const { stdout, stderr } = await execFileAsync(sidecarExe, ['first-run'], {
        windowsHide: true,
        timeout: 60_000,
        // sidecar prints UTF-8 status lines; avoid cjk decode crashes on the
        // parent side (same defensive posture as the sidecar's own _run()).
        encoding: 'utf8',
        // maxBuffer raised from the 1MB default to fit full first-run output.
        maxBuffer: 4 * 1024 * 1024
      })
      logger.info('sidecar first-run (auto-heal) completed', { stdout: stdout.trim(), stderr: stderr.trim() })
    } catch (err) {
      // Non-fatal: leave a clear log so the operator can fall back to plan A
      // (manual `sidecar.exe first-run`). Never crash or block the app.
      logger.error('sidecar first-run (auto-heal) failed; run `sidecar.exe first-run` manually (plan A)', err as Error)
    }
  }

  /** 打开服务端地址配置窗（注册 IPC handler，幂等；保存并关闭后重跑服务自愈）。 */
  private openConfigWindow(): void {
    this.configWindow.registerIpc(
      // 注册：读地址/扫描/写入 + close（存入 sidecar config，关闭配置窗后重跑服务自愈）
      () =>
        registerSidecarConfigIpcHandlers(
          () => this.sidecarExePath(),
          (saveSuccess) => {
            this.configWindow.close()
            if (saveSuccess) {
              // 用户保存成功：config.json 已写入服务端地址，重跑自愈注册/修复服务。
              void this.run().catch((err) => {
                logger.warn('post-config sidecar auto-heal failed (non-fatal)', err as Error)
              })
            }
          }
        ),
      // 注销
      () => unregisterSidecarConfigIpcHandlers()
    )
    this.configWindow.open()
  }

  private isManagedBuild(): boolean {
    const flag = process.env.CHERRY_MANAGED_BUILD
    return flag === '1' || flag === 'true' || flag === 'TRUE'
  }

  /**
   * `$INSTDIR\resources\sidecar\sidecar.exe` — same layout the NSIS managed
   * logic and sidecar.py `_find_nssm()` expect (sys.executable.parent).
   * `process.resourcesPath` = `$INSTDIR\resources` in a packaged app.
   */
  private sidecarExePath(): string | null {
    const candidate = path.join(process.resourcesPath, 'sidecar', SIDECAR_EXE_NAME)
    return candidate
  }

  /**
   * `sc query <svc>` exits 0 when the service exists (even if stopped), non-zero
   * when it does not. Treat any non-zero exit as "not registered" so we retry.
   */
  private async serviceRegistered(): Promise<boolean> {
    try {
      await execFileAsync('sc', ['query', SIDECAR_SERVICE_NAME], {
        windowsHide: true,
        timeout: 10_000,
        encoding: 'utf-8'
      })
      return true
    } catch {
      return false
    }
  }
}
