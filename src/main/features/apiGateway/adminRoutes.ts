import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { agentService } from '@data/services/AgentService'
import { Elysia } from 'elysia'
import * as z from 'zod'

import { DOC_TAGS } from './openapiDocs'

/**
 * Minimal M0-1 admin management routes (Fork).
 *
 * Scope: proves the "managed route writes sqlite → IPC data-changed broadcast →
 * renderer live refresh" chain with the smallest possible surface. It deliberately
 * reuses the official data-change notification path (`notifyDataApiDataChange`)
 * instead of inventing a new IPC channel: that function broadcasts on the existing
 * `DataApi_DataChanged` (`data-api:data-changed`) channel, which the renderer
 * already subscribes to via `useDataChange`. No new channel is defined here.
 *
 * NOT full management surface. This file intentionally contains only what
 * plan-m0.md §1.2 / task V-M0-1 ① requires (update an agent's name/instructions).
 * Provider/key management (V-M0-1 ②③), standalone managed_key auth (F-3), and the
 * full admin API belong to later milestones — not invented here.
 *
 * Auth: mounted inside `v1Routes`' `scoped` guard, so it inherits the existing
 * bearer/x-api-key check (`authorizeApiRequest`). Standalone managed_key is F-3,
 * out of M0 scope.
 */

/**
 * Body schema for `PUT /v1/admin/agents/:id`.
 *
 * Deliberately a subset of the official `UpdateAgentSchema` mutable fields
 * (name + instructions) — exactly what M0-1 ① verifies. The patch is passed
 * through to `AgentService.updateAgent`, which validates the full
 * `UpdateAgentDto` and applies the same transaction / FK / builtin_role guards
 * as the official DataApi PATCH handler (goes through Service, never writes
 * sqlite directly — D20).
 */
const UpdateAdminAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    instructions: z.string().optional()
  })
  .refine((v) => v.name !== undefined || v.instructions !== undefined, {
    message: 'At least one of name / instructions must be provided'
  })

/** Shape returned on success. Mirrors the official DataApi update response. */
export const adminRoutes = new Elysia({ prefix: '/admin' }).put(
  '/agents/:id',
  async ({ params, body, set }) => {
    const parsed = UpdateAdminAgentSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }

    const updated = agentService.updateAgent(params.id, parsed.data)
    if (!updated) {
      set.status = 404
      return { error: `Not Found: Agent ${params.id}` }
    }

    // After commit, broadcast the data-change so every renderer's `useDataChange('/agents', …)`
    // refetches. `/agents` is a collection endpoint; `kind: 'projection'` signals the list value
    // changed. Emitted only AFTER `updateAgent` returned (commit done), per the notify governance
    // fence — a failure here is caught inside `notifyDataApiDataChange` and never affects the write.
    notifyDataApiDataChange([{ endpoint: '/agents', kind: 'projection' }])

    return {
      id: updated.id,
      name: updated.name,
      instructions: updated.instructions,
      updatedAt: updated.updatedAt
    }
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: update agent',
      description:
        "Update an agent's name and/or instructions (managed admin route, M0-1). Requires the same API key as the /v1 routes."
    }
  }
)
