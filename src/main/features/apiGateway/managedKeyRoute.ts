import { application } from '@application'
import { loggerService } from '@logger'
import { Elysia } from 'elysia'

import { isValidToken } from './middleware/auth'
import { DOC_DESCRIPTIONS, DOC_TAGS } from './openapiDocs'

const logger = loggerService.withContext('ApiGateway.ManagedKeyRoute')

/**
 * JJC-20260818-001 — loopback read-only route for the managed key.
 *
 * Sidecar fetches `feature.api_gateway.managed_key` via this single loopback
 * route (`GET /v1/admin/managed-key`) so it never depends on account / file-path
 * consistency across users (install-and-go, B-001 / EC-005).
 *
 * Security model (SC-006 / EC-002 / EC-003 / R-1):
 *  - **loopback-only**: the route rejects any non-loopback remote address with
 *    403. This is the PRIMARY boundary — even a managed build listening on
 *    0.0.0.0 cannot be scraped from the LAN (the boss's concern in R-1).
 *  - **X-Device-Id required**: the caller must self-identify its device; 403
 *    otherwise (EC-003).
 *  - **Bearer defense-in-depth**: if a managed_key already exists, the request
 *    must present it as `Authorization: Bearer <managed_key>` (timing-safe).
 *    On TRUE first boot there is no key yet (self-provisioning): a loopback +
 *    X-Device-Id caller triggers `ensureManagedKey()` (idempotent) and receives
 *    the freshly-generated key. This is NOT a separate bootstrap route / one-time
 *    code (B-002 — boss cancelled decision#3): it is the single route serving the
 *    install-and-go first-boot case, gated by the loopback check that IS the
 *    security boundary. Once a key exists, Bearer is enforced for every re-fetch.
 *
 * Read-only. No broadcast needed.
 *
 * Mounting note: this route is registered OUTSIDE `buildV1Routes`' `scoped`
 * admin guard (which would 403 an unset/absent managed_key, dead-locking first
 * boot). It carries its own self-contained (`local`) guard below, mirroring how
 * `geminiRoutes` escapes the `/v1` scoped guard. It is mounted before
 * `buildV1Routes` in `app.ts`.
 */
export const managedKeyRoute = new Elysia({ prefix: '/v1/admin' }).guard(
  {
    as: 'local',
    beforeHandle: ({ request, server, set, headers }) => {
      // ① loopback-only source (EC-002 / R-1) — the primary boundary.
      const remote = resolveRemoteAddress(request, server)
      if (!remote || !isLoopbackAddress(remote)) {
        set.status = 403
        return { error: 'Forbidden: managed-key route is loopback-only' }
      }
      // ② caller self-identification via X-Device-Id (EC-003).
      const deviceId = headers['x-device-id']
      if (!deviceId || deviceId.trim() === '') {
        set.status = 403
        return { error: 'Forbidden: missing X-Device-Id' }
      }
      // ③ Once a managed_key already exists, enforce Bearer (defense-in-depth).
      // The `@elysia/bearer` plugin's `bearer` derive is only registered inside
      // `buildV1Routes`, which this loopback route deliberately escapes — so parse
      // the Authorization: Bearer token from headers directly.
      const authorization = headers['authorization']
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
      const existing = application.get('PreferenceService').get('feature.api_gateway.managed_key')
      if (typeof existing === 'string' && existing !== '' && !isValidToken(bearer, existing)) {
        set.status = 403
        return { error: 'Forbidden' }
      }
      return undefined
    }
  },
  (app) =>
    app.get(
      '/managed-key',
      async ({ set }) => {
        const existing = application.get('PreferenceService').get('feature.api_gateway.managed_key')
        let managedKey = typeof existing === 'string' ? existing : ''
        if (managedKey === '') {
          // Self-provision on true first boot (idempotent, SC-003/SC-004).
          const apiGatewayService = application.get('ApiGatewayService')
          managedKey = await apiGatewayService.ensureManagedKey()
        }
        if (managedKey === '') {
          set.status = 500
          logger.error('managed key generation failed')
          return { error: 'Internal Server Error' }
        }
        return { managed_key: managedKey }
      },
      {
        detail: {
          tags: [DOC_TAGS.cherry],
          summary: 'Admin: read local managed key (loopback-only)',
          description: DOC_DESCRIPTIONS.admin_read_managed_key
        }
      }
    )
)

/**
 * Best-effort resolve of the request's source address, working across adapters.
 *
 * **Bun adapter**: `server.requestIP(request)` is supported — but the
 * `@elysia/node` adapter implemented it as a *throwing stub* (it throws
 * `"This adapter doesn't support Bun requestIP method"`) and its `server`
 * context is null, so we must never let a node-side throw break the guard.
 *
 * **Node adapter (production)**: the raw Node `IncomingMessage` is reachable at
 * `request.runtime.node.req` (srvx/crossws runtime the `@elysia/node` adapter
 * attaches), giving us the real client socket.
 *
 * Returns the client address string, or undefined when it cannot be determined —
 * in which case the caller rejects the request (fail-closed: an unbounded
 * source is refused, never allowed).
 */
const resolveRemoteAddress = (request: Request, server: unknown): string | undefined => {
  // Bun (or any adapter that implements requestIP properly).
  try {
    const viaRequestIP = (
      server as { requestIP?: (req: Request) => { address?: string } | null | undefined } | null | undefined
    )?.requestIP?.(request)
    if (viaRequestIP && typeof viaRequestIP.address === 'string') return viaRequestIP.address
  } catch {
    // node's requestIP stub throws — fall through to the node socket.
  }
  // Node adapter: raw IncomingMessage socket carries the real client address.
  const nodeReq = (request as unknown as { runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } } })
    .runtime?.node?.req
  const nodeAddr = nodeReq?.socket?.remoteAddress
  return typeof nodeAddr === 'string' && nodeAddr !== '' ? nodeAddr : undefined
}

/** True for loopback / loopback-v4-mapped addresses. */
const isLoopbackAddress = (address: string): boolean => {
  const a = address.trim().toLowerCase()
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost') return true
  return false
}
