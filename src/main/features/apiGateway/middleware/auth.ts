import { application } from '@application'
import crypto from 'crypto'

export const isValidToken = (token: string, apiKey: string): boolean => {
  const tokenBuf = Buffer.from(token, 'utf8')
  const keyBuf = Buffer.from(apiKey, 'utf8')
  if (tokenBuf.length !== keyBuf.length) {
    return false
  }
  return crypto.timingSafeEqual(tokenBuf, keyBuf)
}

export type AuthFailure = { status: 401 | 403; error: string }

/**
 * The protected surface an incoming request is targeting. `/v1/admin/*` is the
 * managed-operator surface (Fork F-3) and authenticates with the independent
 * `managed_key` via Bearer only; everything else under `/v1` is the ordinary
 * employee API surface and authenticates with `api_key`.
 */
export type AuthScope = 'api' | 'admin'

/**
 * Resolve whether a registered route path belongs to the managed admin surface.
 * Admin routes live under `/v1/admin/*` (see adminRoutes.ts).
 */
export const isAdminPath = (path: string): boolean => path.startsWith('/v1/admin/')

/**
 * Validate the credentials presented to the protected API routes.
 *
 * Two independent keys, chosen by `scope`:
 * - `api` scope (the ordinary `/v1` surface): the Anthropic `x-api-key` header
 *   (takes priority), the OpenAI `Authorization: Bearer <token>` (extracted by
 *   the `@elysia/bearer` plugin in `app.ts` and passed as `bearerToken`), and the
 *   Gemini `x-goog-api-key` header / `?key=` query param (`googleApiKey`). All
 *   are compared against `feature.api_gateway.api_key`.
 * - `admin` scope (the managed `/v1/admin/*` surface): Bearer ONLY, compared
 *   against the independent `feature.api_gateway.managed_key`. The `x-api-key`
 *   header is deliberately NOT accepted here (F-3 AC5) — admin access is a
 *   distinct credential from the employee API key, so a Bearer token must be
 *   presented. If `managed_key` is unset, admin is refused (F-3 AC4).
 *
 * Returns an `AuthFailure` to short-circuit the request, or `undefined` to allow it.
 */
export const authorizeApiRequest = (
  xApiKey: string | undefined,
  bearerToken: string | undefined,
  options?: { scope?: AuthScope; googleApiKey?: string }
): AuthFailure | undefined => {
  const scope = options?.scope ?? 'api'

  if (scope === 'admin') {
    // Bearer-only against managed_key — x-api-key is never consulted here.
    const token = bearerToken?.trim()
    if (!token) {
      return { status: 401, error: 'Unauthorized: missing credentials' }
    }
    const managedKey = application.get('PreferenceService').get('feature.api_gateway.managed_key')
    if (!managedKey) {
      return { status: 403, error: 'Forbidden' }
    }
    return isValidToken(token, managedKey) ? undefined : { status: 403, error: 'Forbidden' }
  }

  const token = xApiKey?.trim() || bearerToken?.trim() || options?.googleApiKey?.trim()

  if (!token) {
    return { status: 401, error: 'Unauthorized: missing credentials' }
  }

  const apiKey = application.get('PreferenceService').get('feature.api_gateway.api_key')
  if (!apiKey) {
    return { status: 403, error: 'Forbidden' }
  }

  if (isValidToken(token, apiKey)) {
    return undefined
  }

  return { status: 403, error: 'Forbidden' }
}
