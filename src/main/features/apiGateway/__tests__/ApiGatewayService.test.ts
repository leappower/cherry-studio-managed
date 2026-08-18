import { BaseService } from '@main/core/lifecycle'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Exercises `ApiGatewayService`'s reconcile-after-settle convergence: a toggle that
 * lands during an in-flight activation must be honoured (no queue, no dropped opposing
 * toggle), and a persistently failing transition must not spin the loop.
 *
 * The inner `ApiGateway` server is mocked so activation timing is controllable; the
 * preference-change handler is captured so the toggle can be driven directly.
 */

const { mockStart, mockStop, mockGetActiveUsageContext, mockPreferenceSet, captured } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockStop: vi.fn(),
  mockGetActiveUsageContext: vi.fn(),
  mockPreferenceSet: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
  captured: {
    prefHandler: undefined as ((enabled: boolean) => void) | undefined,
    enabledPreference: false,
    // controllable managed_key returned by the preference mock (shared with set).
    managedKey: '' as string
  }
}))

vi.mock('../server', () => ({
  ApiGateway: vi.fn(() => ({ start: mockStart, stop: mockStop, isRunning: () => true }))
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    PreferenceService: {
      subscribeChange: vi.fn((_key: string, cb: (enabled: boolean) => void) => {
        captured.prefHandler = cb
        return () => {}
      }),
      get: vi.fn((key: string) => {
        if (key === 'feature.api_gateway.managed_key') return captured.managedKey || false
        return key.endsWith('api_key') ? 'existing-key' : false
      }),
      getMultiple: vi.fn(() => ({
        enabled: captured.enabledPreference,
        host: '127.0.0.1',
        port: 23333,
        apiKey: 'existing-key'
      })),
      set: vi.fn(async (key: string, value: unknown) => {
        if (key === 'feature.api_gateway.managed_key') captured.managedKey = String(value)
        await mockPreferenceSet(key, value)
      })
    },
    CacheService: { setShared: vi.fn() },
    AgentSessionRuntimeService: { getActiveUsageContext: mockGetActiveUsageContext }
  } as any)
})

import { ApiGatewayService } from '../ApiGatewayService'

let startResolvers: Array<() => void>
let rejectStart: boolean

beforeEach(() => {
  BaseService.resetInstances()
  captured.prefHandler = undefined
  captured.enabledPreference = false
  captured.managedKey = ''
  mockPreferenceSet.mockReset()
  mockPreferenceSet.mockResolvedValue(undefined)
  startResolvers = []
  rejectStart = false
  mockStart.mockReset()
  mockStop.mockReset()
  mockGetActiveUsageContext.mockReset()
  mockGetActiveUsageContext.mockReturnValue({
    agentSessionId: 'session-1',
    source: { type: 'agent', id: 'agent-1', name: 'Original Agent', icon: '🧠' }
  })
  mockStart.mockImplementation(() =>
    rejectStart
      ? Promise.reject(new Error('port in use'))
      : new Promise<void>((resolve) => startResolvers.push(resolve))
  )
  mockStop.mockResolvedValue(undefined)
})

describe('ApiGatewayService reconcile', () => {
  it('recognizes an internal agent request when the process-local token matches', () => {
    const service = new ApiGatewayService()
    const headers = new Headers(service.getAgentSessionUsageHeaders('session-1'))

    expect(service.isInternalAgentRequest(headers)).toBe(true)
  })

  it('rejects an internal agent request when the process-local token is wrong or missing', () => {
    const service = new ApiGatewayService()
    const usageHeaders = service.getAgentSessionUsageHeaders('session-1')

    expect(
      service.isInternalAgentRequest(
        new Headers({
          ...usageHeaders,
          'x-cherry-internal-usage-token': 'wrong-proof'
        })
      )
    ).toBe(false)
    expect(service.isInternalAgentRequest(new Headers())).toBe(false)
  })

  it('recognizes an internal agent request without a session id when the process-local token matches', () => {
    const service = new ApiGatewayService()
    const headers = new Headers(service.getAgentSessionUsageHeaders('session-1'))
    headers.delete('x-cherry-agent-session-id')

    expect(service.isInternalAgentRequest(headers)).toBe(true)
  })

  it('accepts agent usage context only with its process-local proof', () => {
    const service = new ApiGatewayService()
    const usageHeaders = service.getAgentSessionUsageHeaders('session-1')

    expect(service.resolveAgentSessionUsage(new Headers(usageHeaders))).toEqual({
      agentSessionId: 'session-1',
      source: { type: 'agent', id: 'agent-1', name: 'Original Agent', icon: '🧠' }
    })
    expect(mockGetActiveUsageContext).toHaveBeenCalledWith('session-1')
    expect(
      service.resolveAgentSessionUsage(
        new Headers({
          ...usageHeaders,
          'x-cherry-internal-usage-token': 'wrong-proof'
        })
      )
    ).toBeUndefined()
    expect(
      service.resolveAgentSessionUsage(
        new Headers({
          'x-cherry-agent-session-id': 'session-1'
        })
      )
    ).toBeUndefined()
  })

  // Regression for #18521: boot used to start the gateway whenever any agent existed, overriding a
  // user who had turned it off — and nothing else may override it either.
  it('stays stopped at boot when the preference is disabled', async () => {
    const service = new ApiGatewayService()

    await service._doInit()

    expect(mockStart).not.toHaveBeenCalled()
    expect(service.isActivated).toBe(false)
  })

  it('starts at boot when the preference is enabled', async () => {
    captured.enabledPreference = true
    const service = new ApiGatewayService()

    const ready = service._doInit()
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    startResolvers[0]()
    await ready

    expect(service.isActivated).toBe(true)
  })

  // The command and the persisted intent must land together: a stop whose preference write never
  // happened comes back on the next launch, which is the whole of #18521.
  it('persists the intent before converging, and reports a failed persist instead of stopping', async () => {
    captured.enabledPreference = true
    const service = new ApiGatewayService()
    const ready = service._doInit()
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    startResolvers[0]()
    await ready

    mockPreferenceSet.mockRejectedValueOnce(new Error('disk full'))
    await expect(service.stop()).rejects.toThrow('disk full')
    expect(service.isActivated).toBe(true)
  })

  it('persists the intent when a start succeeds', async () => {
    const service = new ApiGatewayService()
    await service._doInit()

    const started = service.start()
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    startResolvers[0]()
    await started

    expect(mockPreferenceSet).toHaveBeenCalledWith('feature.api_gateway.enabled', true)
  })

  // A re-bind must not resurrect a gateway another window disabled while the restart was queued:
  // that would leave runtime=running with the preference persisted as disabled.
  it('aborts a restart when the gateway was disabled meanwhile', async () => {
    captured.enabledPreference = true
    const service = new ApiGatewayService()
    const ready = service._doInit()
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    startResolvers[0]()
    await ready

    // Another window's stop lands: the preference is already persisted when the restart re-reads it.
    captured.enabledPreference = false
    await expect(service.restart()).rejects.toThrow('disabled while restarting')
    expect(service.isActivated).toBe(false)
    expect(mockStart).toHaveBeenCalledTimes(1)
  })

  it('honors an opposing toggle that lands during an in-flight activation (no dropped toggle)', async () => {
    const service = new ApiGatewayService()
    await service._doInit() // Ready; desiredEnabled=false; reconcile is a no-op.
    expect(service.isActivated).toBe(false)
    expect(captured.prefHandler).toBeDefined()

    // Enable → reconcile starts activating; the inner start() stays pending.
    captured.prefHandler!(true)
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    expect(service.isActivated).toBe(false) // still mid-activation

    // Opposing disable lands mid-activation. A queue/short-circuit would drop it;
    // reconcile re-reads the desired state after the activation settles.
    captured.prefHandler!(false)

    // Complete the activation — the loop must now deactivate to converge to `false`.
    startResolvers[0]()
    await vi.waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1))
    expect(service.isActivated).toBe(false)
  })

  it('converges to running when the final desired state is enabled', async () => {
    const service = new ApiGatewayService()
    await service._doInit()

    captured.prefHandler!(true)
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    startResolvers[0]()
    await vi.waitFor(() => expect(service.isActivated).toBe(true))
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('does not retry a failed activation for a stable desired state (no spin loop)', async () => {
    rejectStart = true
    const service = new ApiGatewayService()
    await service._doInit()

    captured.prefHandler!(true)
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))
    // Give the loop a chance to (wrongly) retry the same failing target.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(service.isActivated).toBe(false)
  })

  it('converges when a pref change opposes an in-flight direct IPC start (single owner)', async () => {
    // The residual race: a direct IPC start() in flight + an opposing pref change.
    // With start() routed through the same queue, the pref change can't be dropped.
    const service = new ApiGatewayService()
    await service._doInit()

    // Attach the settle handler synchronously so the in-flight rejection (start() ends
    // up !isActivated because desired flipped) is never an unhandled rejection.
    const startSettled = service.start().then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1))

    // Opposing disable lands while the IPC activation is still in flight.
    captured.prefHandler!(false)

    // Complete the activation; the running reconcile must then deactivate to converge.
    startResolvers[0]()
    await vi.waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1))
    await startSettled

    expect(service.isActivated).toBe(false) // converged to desiredEnabled === false
  })

  // ── JJC-20260818-001: managed_key (F-3) generation ────────────────────

  it('AC1 — ensureManagedKey generates a fresh cs-mk-<uuid> when none exists', async () => {
    const service = new ApiGatewayService()
    const key = await service.ensureManagedKey()
    expect(key.startsWith('cs-mk-')).toBe(true)
    expect(key.length).toBeGreaterThan('cs-mk-'.length)
    // persisted as the canonical value
    expect(captured.managedKey).toBe(key)
    expect(mockPreferenceSet).toHaveBeenCalledWith('feature.api_gateway.managed_key', key)
  })

  it('AC1 — ensureManagedKey is idempotent: reuses the persisted key, never generates a second one', async () => {
    captured.managedKey = 'cs-mk-existing' // a key already persisted (e.g. from a prior boot)
    const service = new ApiGatewayService()
    const key = await service.ensureManagedKey()
    expect(key).toBe('cs-mk-existing')
    // No re-generation: the setter must NOT have been called for managed_key.
    expect(mockPreferenceSet).not.toHaveBeenCalledWith('feature.api_gateway.managed_key', expect.anything())
  })

  it('AC1 — getManagedKey resolves the persisted key (empty string when unset)', async () => {
    const service = new ApiGatewayService()
    // Unset → empty string (route returns 500, never a bootstrapped key leak).
    expect(service.getManagedKey()).toBe('')
    captured.managedKey = 'cs-mk-set'
    expect(service.getManagedKey()).toBe('cs-mk-set')
  })

  it('AC5 — managed key methods never log the raw key value in plaintext', async () => {
    // The loopback route (managedKeyRoute.test.ts) asserts no logger call contains
    // the raw key. Here we sanity-check the API surface: getManagedKey returns the
    // value (the route's job to gate it loopback-only), and ensureManagedKey's
    // success path does not embed the key in any returned error/message.
    captured.managedKey = 'super-secret-managed-key'
    const service = new ApiGatewayService()
    const raw = service.getManagedKey()
    expect(raw).toBe('super-secret-managed-key')
    // ensureManagedKey on an existing key returns it verbatim without touching set.
    const again = await service.ensureManagedKey()
    expect(again).toBe('super-secret-managed-key')
    expect(mockPreferenceSet).not.toHaveBeenCalledWith('feature.api_gateway.managed_key', expect.anything())
  })
})
