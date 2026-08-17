import { IpcChannel } from '@shared/IpcChannel'
import { useEffect, useRef, useState } from 'react'

const DEFAULT_ADDR = '192.168.3.181:2334'

/** 调用受控 IPC（window.electron 由 simplest preload 注入）。 */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return (window as any).electron.ipcRenderer.invoke(channel, ...args)
}

export default function SidecarConfigApp() {
  const [addr, setAddr] = useState(DEFAULT_ADDR)
  const [scanning, setScanning] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const didInit = useRef(false)

  // 首次加载：读取当前已配置的服务端地址（有则预填）
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    void (async () => {
      try {
        const current = (await invoke(IpcChannel.SidecarConfig_GetServerUrl)) as string
        if (current) setAddr(current)
      } catch {
        // 读取失败保持默认
      }
    })()
  }, [])

  const handleScan = async () => {
    setScanning(true)
    setError('')
    try {
      const found = (await invoke(IpcChannel.SidecarConfig_ScanLan)) as string[]
      setCandidates(found ?? [])
      if (!found || found.length === 0) {
        setError('局域网内未扫描到受管服务端。请确认服务端已启动，或手动输入 IP:端口。')
      }
    } catch {
      setError('扫描失败，请手动输入服务端 IP:端口。')
    } finally {
      setScanning(false)
    }
  }

  const handleSave = async () => {
    const trimmed = addr.trim()
    if (!trimmed) {
      setError('请输入服务端 IP:端口。')
      return
    }
    setSaving(true)
    setError('')
    try {
      const ok = (await invoke(IpcChannel.SidecarConfig_SetServer, trimmed)) as boolean
      if (!ok) {
        setError('写入服务端地址失败，请检查权限后重试。')
        setSaving(false)
        return
      }
      setSaved(true)
    } catch {
      setError('保存失败，请重试。')
      setSaving(false)
    }
  }

  // 保存成功后关闭窗口（短暂提示后自动关，告知 main 已保存成功）
  useEffect(() => {
    if (saved) {
      setTimeout(() => {
        void invoke(IpcChannel.SidecarConfig_Close, true)
      }, 600)
    }
  }, [saved])

  const closeWindow = () => {
    void invoke(IpcChannel.SidecarConfig_Close, false)
  }

  const selectCandidate = (c: string) => setAddr(c)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '24px 28px',
        boxSizing: 'border-box',
        gap: 14
      }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 600, color: '#1f2329' }}>配置 CherryStudio 服务端</div>
        <div style={{ fontSize: 13, color: '#8a919f', marginTop: 4 }}>
          请确认本机要连接的服务端地址（员工机将连接此服务端）。
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: 13, color: '#4e5969', whiteSpace: 'nowrap' }}>服务端 IP:端口</label>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="例如 192.168.3.181:2334"
          style={{
            flex: 1,
            padding: '8px 10px',
            border: '1px solid #c9cdd4',
            borderRadius: 6,
            fontSize: 14,
            outline: 'none',
            background: '#fff'
          }}
        />
        <button
          type="button"
          onClick={handleScan}
          disabled={scanning}
          style={{
            padding: '8px 14px',
            border: 'none',
            borderRadius: 6,
            background: '#165dff',
            color: '#fff',
            fontSize: 13,
            cursor: scanning ? 'default' : 'pointer',
            opacity: scanning ? 0.6 : 1
          }}>
          {scanning ? '扫描中...' : '扫描局域网'}
        </button>
      </div>

      {candidates.length > 0 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 90 }}>
          <div style={{ fontSize: 13, color: '#4e5969' }}>扫描到的服务端（点击选中）：</div>
          <div style={{ border: '1px solid #e5e6eb', borderRadius: 6, overflow: 'hidden' }}>
            {candidates.map((c) => (
              <div
                key={c}
                onClick={() => selectCandidate(c)}
                style={{
                  padding: '8px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  borderBottom: '1px solid #f2f3f5',
                  background: addr === c ? '#e8f3ff' : '#fff'
                }}>
                {c}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: '#f53f3f', padding: '8px 12px', background: '#ffece8', borderRadius: 6 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 'auto' }}>
        <button
          type="button"
          onClick={closeWindow}
          style={{
            padding: '8px 18px',
            border: '1px solid #c9cdd4',
            borderRadius: 6,
            background: '#fff',
            color: '#4e5969',
            fontSize: 13,
            cursor: 'pointer'
          }}>
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || saved}
          style={{
            padding: '8px 18px',
            border: 'none',
            borderRadius: 6,
            background: saved ? '#00b42a' : '#165dff',
            color: '#fff',
            fontSize: 13,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1
          }}>
          {saved ? '已保存 ✓' : saving ? '保存中...' : '确认并保存'}
        </button>
      </div>
    </div>
  )
}
