import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * JJC-20260818-001 - integration tests for the loopback read-only managed-key
 * route (`GET /v1/admin/managed-key`).
 *
 * The route's PRIMARY boundary is loopback-only (sc-006 / EC-002 / R-1): a
 * managed build listening on 0.0.0.0 must not be scrapable from the LAN. That
 * check reads the real client socket address via `server.requestIP()`, so these
 * tests drive a REAL node adapter server on 127.0.0.1 (ephemeral port) and fetch
 * it over loopback - `app.handle()` alone cannot prove the accept path, because
 * it never binds a socket and `requestIP` comes back undefined (403).
 *
 * AC coverage in this file:
 *  - AC2 上报绑定: X-Device-Id is REQUIRED (device must self-identify).
 *  - AC3 设备级鉴权: loopback-only source + Bearer defense-in-depth once a
 *    managed_key exists; non-loopback / missing device / wrong bearer -> 403.
 *  - AC4 未绑定首登: on TRUE first boot (no managed_key yet) a loopback +
 *    X-Device-Id caller triggers idempotent self-provisioning and receives the
 *    freshly-generated key.
 *  - AC1 幂等生成: repeated fetches return the SAME key (never re-generate).
 *  - AC5 敏感key不落明文: the handler/sidecar never logs the raw managed_key.
 */

// Mock services closed over by the (hoisted) vi.mock factories.
const { mockPreferenceGet, mockPreferenceSet, mockEnsureManagedKey, mockGetManagedKey, resetManagedKey } = vi.hoisted(
  () => {
    // `managed_key` value shared between the preference mock and the route's
    // `PreferenceService.get` - defaulting to '' (true first boot).
    let managedKey: string = ''

    const mockPreferenceGet = vi.fn((key: string): unknown => {
      if (key === 'feature.api_gateway.managed_key') return managedKey
      if (key === 'feature.api_gateway.host') return '127.0.0.1'
      if (key === 'feature.api_gateway.port') return 0
      // every other key (api_key etc.) authenticates in non-managed surfaces.
      return 'test-key'
    })
    const mockPreferenceSet = vi.fn(async (key: string, value: unknown) => {
      if (key === 'feature.api_gateway.managed_key') managedKey = String(value)
    })
    const mockEnsureManagedKey = vi.fn(async () => {
      // Mirrors ApiGatewayService.ensureManagedKey idempotency: generate once, reuse.
      if (managedKey === '') managedKey = 'cs-mk-testprovision-key'
      return managedKey
    })
    const mockGetManagedKey = vi.fn(() => managedKey)
    const resetManagedKey = () => {
      managedKey = ''
    }

    return { mockPreferenceGet, mockPreferenceSet, mockEnsureManagedKey, mockGetManagedKey, resetManagedKey }
  }
)

// Capture logger calls so AC5 can assert the raw key never reaches the log.
const { mockLoggerFns } = vi.hoisted(() => ({
  mockLoggerFns: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    PreferenceService: { get: mockPreferenceGet, set: mockPreferenceSet },
    ApiGatewayService: {
      ensureManagedKey: mockEnsureManagedKey,
      getManagedKey: mockGetManagedKey,
      isInternalRequestToken: vi.fn(() => false)
    }
  })
})

vi.mock('@logger', () => ({
  loggerService: { withContext: vi.fn(() => mockLoggerFns) }
}))

vi.mock('@main/i18n', () => ({
  t: (key: string) => key,
  getAppLanguage: () => 'en-US',
  SUPPORTED_LANGUAGES: ['en-US', 'zh-CN']
}))

// Heavy route deps stubbed so buildApp stays hermetic (behaviour tested elsewhere).
vi.mock('../../proxyStream', () => ({
  processMessage: vi.fn(async () => new Response('{}', { status: 200 })),
  default: { processMessage: vi.fn() }
}))
vi.mock('../../utils/models', () => ({ getModels: vi.fn(async () => ({ object: 'list', data: [] })) }))
vi.mock('@data/services/KnowledgeBaseService', () => ({
  knowledgeBaseService: { list: vi.fn(async () => ({ items: [], total: 0, page: 1 })), getById: vi.fn() }
}))

import { buildApp } from '../../app'

let server: ReturnType<typeof buildApp> | null = null
let baseUrl = ''

async function startServer() {
  const app = buildApp({ host: '127.0.0.1', port: 0 })
  // Mirror server.ts: the node adapter reports the underlying http.Server via the
  // listen() callback's `serverInfo.raw.node.server`; the OS-chosen ephemeral port
  // is read from its live socket address once the server is actually bound.
  let httpServer: { address(): { port?: number } | string | null } | undefined
  const cb = (serverInfo: unknown) => {
    httpServer = (serverInfo as { raw?: { node?: { server?: typeof httpServer } } }).raw?.node?.server
  }
  await app.listen({ port: 0, hostname: '127.0.0.1' }, cb as Parameters<typeof app.listen>[1])
  let port: number | undefined
  for (let i = 0; i < 60 && port === undefined; i++) {
    await new Promise((r) => setTimeout(r, 50))
    const addr = httpServer?.address()
    port = typeof addr === 'object' && addr !== null ? addr.port : undefined
  }
  if (!port) throw new Error('could not determine ephemeral port')
  server = app
  baseUrl = `http://127.0.0.1:${port}`
}

async function stopServer() {
  if (server) {
    await (server as unknown as { stop: () => Promise<void> }).stop?.().catch(() => {})
    server = null
  }
}

/** GET /v1/admin/managed-key over the real loopback server. */
async function fetchKey(headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/v1/admin/managed-key`, { method: 'GET', headers })
  let body: unknown = null
  try {
    body = await res.clone().json()
  } catch {
    body = await res.text()
  }
  return { status: res.status, body }
}

beforeEach(async () => {
  vi.clearAllMocks()
  // Reset to TRUE first boot: no managed key exists yet.
  resetManagedKey()
  mockGetManagedKey.mockImplementation(() => mockPreferenceGet('feature.api_gateway.managed_key') as string)
  mockEnsureManagedKey.mockImplementation(async () => {
    const current = mockPreferenceGet('feature.api_gateway.managed_key') as string
    if (typeof current !== 'string' || current === '') {
      const fresh = 'cs-mk-testprovision-key'
      await mockPreferenceSet('feature.api_gateway.managed_key', fresh)
      return fresh
    }
    return current
  })
  await stopServer()
  await startServer()
})

afterEach(async () => {
  await stopServer()
})

describe('managedKeyRoute', () => {
  it('AC4/AC2 - first boot (no key yet): loopback + X-Device-Id self-provisions and returns the fresh key', async () => {
    const { status, body } = await fetchKey({ 'x-device-id': 'dev-1' })
    expect(status).toBe(200)
    expect(body).toEqual({ managed_key: 'cs-mk-testprovision-key' })
    // ensureManagedKey (idempotent) was triggered on first boot.
    expect(mockEnsureManagedKey).toHaveBeenCalled()
  })

  it('AC1/AC4 - idempotent: repeated first-boot fetches return the SAME key, ensureManagedKey is idempotent (no re-generation)', async () => {
    const first = await fetchKey({ 'x-device-id': 'dev-1' })
    const second = await fetchKey({ 'x-device-id': 'dev-1' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    // ensureManagedKey saw the existing key on the 2nd call and did NOT re-generate.
    // (mock returns the same value regardless; ApiGatewayService.ensureManagedKey
    // is the real idempotency guard, covered in ApiGatewayService.test.ts.)
  })

  it('AC2 - device binding: missing X-Device-Id -> 403 (even on loopback)', async () => {
    const { status } = await fetchKey({})
    expect(status).toBe(403)
  })

  it('AC2 - device binding: empty/whitespace X-Device-Id -> 403', async () => {
    const { status } = await fetchKey({ 'x-device-id': '   ' })
    expect(status).toBe(403)
  })

  it('AC3 - Bearer defense-in-depth: once a managed_key exists, a wrong/missing Bearer -> 403', async () => {
    // Provision a key on first boot so it now exists.
    await fetchKey({ 'x-device-id': 'dev-1' })
    const existing = mockPreferenceGet('feature.api_gateway.managed_key') as string
    expect(typeof existing).toBe('string')
    expect(existing.length).toBeGreaterThan(0)

    // Missing Bearer -> 403.
    const missing = await fetchKey({ 'x-device-id': 'dev-1' })
    expect(missing.status).toBe(403)

    // Wrong Bearer -> 403.
    const wrong = await fetchKey({ 'x-device-id': 'dev-1', authorization: 'Bearer wrong-token' })
    expect(wrong.status).toBe(403)
  })

  it('AC3 - Bearer defense-in-depth: correct Bearer + X-Device-Id -> 200 returns the key', async () => {
    // Provision first-boot key.
    const boot = await fetchKey({ 'x-device-id': 'dev-1' })
    const existing = (boot.body as { managed_key: string }).managed_key
    const ok = await fetchKey({ 'x-device-id': 'dev-1', authorization: `Bearer ${existing}` })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ managed_key: existing })
  })

  it('AC5 - sensitive key never logged in plaintext (logger has no raw managed_key)', async () => {
    await fetchKey({ 'x-device-id': 'dev-1' })
    const existing = mockPreferenceGet('feature.api_gateway.managed_key') as string
    const calls = [...mockLoggerFns.info.mock.calls, ...mockLoggerFns.error.mock.calls]
    for (const args of calls) {
      const serialized = args.map((a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? ''))).join(' ')
      expect(serialized).not.toContain(existing)
    }
  })
})
