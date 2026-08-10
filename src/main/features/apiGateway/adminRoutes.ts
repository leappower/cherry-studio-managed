import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { agentService } from '@data/services/AgentService'
import { aiUsageRecordService } from '@data/services/AiUsageRecordService'
import { providerService } from '@data/services/ProviderService'
import { createAgent } from '@main/ai/agents/createAgent'
import { AiUsageRecordListQuerySchema } from '@shared/data/api/schemas/aiUsageRecords'
import {
  CreateProviderSchema,
  ListProvidersQuerySchema,
  ReplaceProviderApiKeysSchema,
  UpdateProviderSchema
} from '@shared/data/api/schemas/providers'
import { CreateAgentCommandSchema } from '@shared/ipc/schemas/ai'
import { Elysia } from 'elysia'
import * as z from 'zod'

import { DOC_TAGS } from './openapiDocs'

/**
 * Managed admin management routes (Fork). Extends the M0-1 minimal surface
 * with the M0-1②③ / M0-4 / M0-5 routes: provider CRUD, agent creation, and
 * usage reads.
 *
 * Design rules (M0-1 lessons, enforced here):
 * - All `/v1/admin/*` routes are mounted inside `v1Routes`' `scoped` guard and
 *   therefore authenticate ONLY via `Authorization: Bearer <key>` (the
 *   `x-api-key` header does NOT propagate into this Elysia instance — verified
 *   in M0-1; see result-m0-1.md). We do not invent a separate auth scheme here.
 * - Every write goes through the official data Service (ProviderService /
 *   AgentService / AiUsageRecordService) — never direct sqlite (D20).
 * - After a successful commit, broadcast the data change via the official
 *   `notifyDataApiDataChange` → `data-api:data-changed` channel so every
 *   renderer's `useDataChange(...)` refetches. No new channel is invented.
 * - Scope is strictly what plan-m0.md / 方案 v4.0 define; no undeclared
 *   capabilities are added.
 */

/** Body schema for `PUT /v1/admin/agents/:id`. */
const UpdateAdminAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    instructions: z.string().optional()
  })
  .refine((v) => v.name !== undefined || v.instructions !== undefined, {
    message: 'At least one of name / instructions must be provided'
  })

export const adminRoutes = new Elysia({ prefix: '/admin' })

// ---------------------------------------------------------------------------
// M0-1 ① / existing — update an agent's name / instructions.
// ---------------------------------------------------------------------------
adminRoutes.put(
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

    // Commit done — broadcast the `/agents` projection change.
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
        "Update an agent's name and/or instructions (managed admin route, M0-1). Requires `Authorization: Bearer`."
    }
  }
)

// ---------------------------------------------------------------------------
// M0-4 — create an agent (official orchestration: provisions the data
// directory + writes sqlite through AgentService.createAgentWithId).
// ---------------------------------------------------------------------------
adminRoutes.post(
  '/agents',
  async ({ body, set }) => {
    const parsed = CreateAgentCommandSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }

    const created = await createAgent(parsed.data)
    // Commit done — broadcast the `/agents` projection change.
    notifyDataApiDataChange([{ endpoint: '/agents', kind: 'projection' }])

    return {
      id: created.id,
      name: created.name,
      type: created.type,
      model: created.model,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    }
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: create agent',
      description:
        'Create an agent (managed admin route, M0-4). Body follows the official CreateAgentCommand schema (name/type/model/instructions/configuration/tools/skills). Requires `Authorization: Bearer`.'
    }
  }
)

// ---------------------------------------------------------------------------
// M0-1② / M0-4 — provider CRUD.
// ---------------------------------------------------------------------------

/** List providers (M0-1②). Read-only — no broadcast needed. */
adminRoutes.get(
  '/providers',
  async ({ query, set }) => {
    const parsed = ListProvidersQuerySchema.safeParse(query ?? {})
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    return providerService.list(parsed.data)
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: list providers',
      description:
        'List providers (managed admin route, M0-1②). Optional `?enabled=true|false` filter. Requires `Authorization: Bearer`.'
    }
  }
)

/** Create a provider (M0-1② / M0-4). */
adminRoutes.post(
  '/providers',
  async ({ body, set }) => {
    const parsed = CreateProviderSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    const created = providerService.create(parsed.data)
    notifyDataApiDataChange([{ endpoint: '/providers', kind: 'projection' }])
    return created
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: create provider',
      description:
        'Create a provider (managed admin route, M0-1②/M0-4). Body follows the official CreateProviderDto. Requires `Authorization: Bearer`.'
    }
  }
)

/** Update a provider (M0-1② / M0-4). */
adminRoutes.put(
  '/providers/:id',
  async ({ params, body, set }) => {
    const parsed = UpdateProviderSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    const updated = providerService.update(params.id, parsed.data)
    notifyDataApiDataChange([{ endpoint: '/providers', kind: 'projection' }])
    return updated
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: update provider',
      description:
        'Update a provider (managed admin route, M0-1②/M0-4). Body follows the official UpdateProviderDto. Requires `Authorization: Bearer`.'
    }
  }
)

/**
 * Replace a provider's API keys (M0-1③).
 *
 * Note (方案 7.4): the API key is held by the third-party relay side. This
 * route only updates the employee-side provider's stored `apiKeys` field; it
 * does NOT control relay-side revocation. Revocation is an operator action on
 * the relay, separate from this route.
 */
adminRoutes.put(
  '/providers/:id/api-keys',
  async ({ params, body, set }) => {
    const parsed = ReplaceProviderApiKeysSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    const updated = providerService.replaceApiKeys(params.id, parsed.data.keys)
    notifyDataApiDataChange([{ endpoint: '/providers', kind: 'projection' }])
    return updated
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: replace provider API keys',
      description:
        'Replace a provider\'s stored API keys (managed admin route, M0-1③). Body: `{ "keys": ApiKeyEntry[] }`. Only updates the employee-side provider key field; relay-side revocation is an operator action. Requires `Authorization: Bearer`.'
    }
  }
)

// ---------------------------------------------------------------------------
// M0-5 — read model + token usage from the local `ai_usage_record` table.
// ---------------------------------------------------------------------------

/**
 * Read usage records (M0-5).
 *
 * Maps to the official `AiUsageRecordService.list` (read-only, via the shared
 * `AiUsageRecordListQuery`), which supports `?from=` / `?to=` numeric timestamp
 * window filters and returns the complete record fields
 * (providerId/providerName/modelId/modelName/inputTokens/outputTokens/
 * totalTokens/sourceType/sourceId/sourceName/requestId/recordKind).
 *
 * [待确认] plan §3.4 mentions a `device_id` filter. The official usage service
 * and schema have no device dimension (records are local to the running
 * device — this service reads this device's own `ai_usage_record`), so
 * `device_id` is not representable here without inventing an undeclared
 * capability. Time-window filtering (`from`/`to`) is supported.
 */
adminRoutes.get(
  '/usage',
  async ({ query, set }) => {
    const parsed = AiUsageRecordListQuerySchema.safeParse(query ?? {})
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    return aiUsageRecordService.list(parsed.data)
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: read usage',
      description:
        'Read model + token usage from the local `ai_usage_record` table (managed admin route, M0-5). Supports `?from=` / `?to=` numeric timestamp window filters; returns the full official record fields. Requires `Authorization: Bearer`.'
    }
  }
)
