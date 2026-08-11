import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { agentGlobalSkillService } from '@data/services/AgentGlobalSkillService'
import { agentService } from '@data/services/AgentService'
import { aiUsageRecordService } from '@data/services/AiUsageRecordService'
import { mcpServerService } from '@data/services/McpServerService'
import { providerService } from '@data/services/ProviderService'
import { removeAgentDataDirectory } from '@main/ai/agents/agentDataDirectory'
import { createAgent } from '@main/ai/agents/createAgent'
import { OrderBatchRequestSchema } from '@shared/data/api/schemas/_endpointHelpers'
import { AiUsageRecordListQuerySchema } from '@shared/data/api/schemas/aiUsageRecords'
import { ListMcpServersQuerySchema } from '@shared/data/api/schemas/mcpServers'
import {
  AddProviderApiKeySchema,
  CreateProviderSchema,
  ListProvidersQuerySchema,
  ReplaceProviderApiKeysSchema,
  UpdateProviderSchema
} from '@shared/data/api/schemas/providers'
import { ListSkillsQuerySchema } from '@shared/data/api/schemas/skills'
import { CreateAgentCommandSchema } from '@shared/ipc/schemas/ai'
import { Elysia } from 'elysia'
import * as z from 'zod'

import { DOC_DESCRIPTIONS, DOC_TAGS } from './openapiDocs'

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

    // Commit done — broadcast the `/agents` projection change plus the
    // entity detail endpoint (M0-收尾 S2: detail-page subscribers on
    // `/agents/:agentId` must converge too).
    notifyDataApiDataChange([
      { endpoint: '/agents', kind: 'projection', entityIds: [updated.id] },
      { endpoint: '/agents/:agentId', entityIds: [updated.id] }
    ])

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
      description: DOC_DESCRIPTIONS.admin_update_agent
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
    // Commit done — broadcast the `/agents` projection change plus the
    // entity detail endpoint (M0-收尾 S2).
    notifyDataApiDataChange([
      { endpoint: '/agents', kind: 'projection', entityIds: [created.id] },
      { endpoint: '/agents/:agentId', entityIds: [created.id] }
    ])

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
      description: DOC_DESCRIPTIONS.admin_create_agent
    }
  }
)

// ---------------------------------------------------------------------------
// F-4 — agents list / get / delete / reorder (managed admin CRUD completion).
// ---------------------------------------------------------------------------

/** List agents (F-4). Read-only — no broadcast needed. */
adminRoutes.get(
  '/agents',
  async () => {
    return agentService.listAgents()
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: list agents',
      description: DOC_DESCRIPTIONS.admin_list_agents
    }
  }
)

/** Get a single agent by id (F-4). Read-only — no broadcast needed. */
adminRoutes.get(
  '/agents/:id',
  async ({ params, set }) => {
    const agent = agentService.getAgent(params.id)
    if (!agent) {
      set.status = 404
      return { error: `Not Found: Agent ${params.id}` }
    }
    return agent
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: get agent',
      description: DOC_DESCRIPTIONS.admin_get_agent
    }
  }
)

/**
 * Delete an agent (F-4). Orchestrates the official delete (AgentService
 * removes the row, cascades junctions, purges pins) plus the filesystem data
 * directory removal — mirroring createAgent's provisioning side effect so a
 * managed delete fully releases the agent's per-agent data root.
 */
adminRoutes.delete(
  '/agents/:id',
  async ({ params, set }) => {
    const result = agentService.deleteAgent(params.id)
    if (!result.deleted) {
      set.status = 404
      return { error: `Not Found: Agent ${params.id}` }
    }

    // Commit done — release the on-disk data directory (best-effort, matching
    // createAgent's rollback behaviour).
    const agentsDataRoot = application.getPath('feature.agents.data')
    await removeAgentDataDirectory(agentsDataRoot, params.id).catch(() => undefined)

    // Broadcast the collection projection plus the entity detail endpoint so
    // list AND detail subscribers converge (M0-收尾 S2 convention).
    notifyDataApiDataChange([
      { endpoint: '/agents', kind: 'projection', entityIds: [params.id] },
      { endpoint: '/agents/:agentId', entityIds: [params.id] }
    ])

    return result
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: delete agent',
      description: DOC_DESCRIPTIONS.admin_delete_agent
    }
  }
)

/**
 * Batch reorder agents (F-4). Body follows the official OrderBatchRequest
 * ({ moves: [{ id, anchor }] }). Persists orderKey through AgentService and
 * broadcasts the collection projection so the ordered list converges.
 */
adminRoutes.post(
  '/agents/reorder',
  async ({ body, set }) => {
    const parsed = OrderBatchRequestSchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    agentService.reorderBatch(parsed.data.moves)
    notifyDataApiDataChange([
      { endpoint: '/agents', kind: 'projection', entityIds: parsed.data.moves.map((m) => m.id) }
    ])
    return { ok: true }
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: reorder agents',
      description: DOC_DESCRIPTIONS.admin_reorder_agents
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
      description: DOC_DESCRIPTIONS.admin_list_providers
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
    // M0-收尾 S2: broadcast the collection plus the new entity detail endpoint
    // so list AND detail/api-keys subscribers converge.
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'projection', entityIds: [created.id] },
      { endpoint: '/providers/:providerId', entityIds: [created.id] }
    ])
    return created
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: create provider',
      description: DOC_DESCRIPTIONS.admin_create_provider
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
    // M0-收尾 S2: broadcast the collection plus the entity detail endpoint.
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'projection', entityIds: [params.id] },
      { endpoint: '/providers/:providerId', entityIds: [params.id] }
    ])
    return updated
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: update provider',
      description: DOC_DESCRIPTIONS.admin_update_provider
    }
  }
)

// ---------------------------------------------------------------------------
// F-5 — provider delete / batchUpsert / addApiKey (managed admin CRUD
// completion). Each write broadcasts per the codebase-wide template-path +
// entityIds convention so renderer useDataChange subscriptions converge.
// ---------------------------------------------------------------------------

/**
 * Delete a provider (F-5). Mirrors the data-api DELETE: providerService.delete
 * throws notFound (404) when absent and invalidOperation for managed / preset
 * providers. Broadcasts the collection plus the entity detail endpoint.
 */
adminRoutes.delete(
  '/providers/:id',
  async ({ params, set }) => {
    try {
      providerService.delete(params.id)
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot delete preset provider')) {
        set.status = 403
        return { error: `Forbidden: ${error.message}` }
      }
      set.status = 404
      return { error: `Not Found: Provider ${params.id}` }
    }
    // Commit done — broadcast the collection plus the entity detail endpoint.
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'projection', entityIds: [params.id] },
      { endpoint: '/providers/:providerId', entityIds: [params.id] }
    ])
    return { deleted: true, providerId: params.id }
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: delete provider',
      description: DOC_DESCRIPTIONS.admin_delete_provider
    }
  }
)

/**
 * Batch upsert providers (F-5). Body is an array of the official
 * CreateProviderDto. Insert-only (existing ids are filtered by the service).
 * Broadcasts the `/providers` collection projection.
 */
adminRoutes.post(
  '/providers/batchUpsert',
  async ({ body, set }) => {
    const parsed = z.array(CreateProviderSchema).safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    providerService.batchUpsert(parsed.data)
    notifyDataApiDataChange([{ endpoint: '/providers', kind: 'projection', entityIds: [] }])
    return { ok: true, count: parsed.data.length }
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: batch upsert providers',
      description: DOC_DESCRIPTIONS.admin_batch_upsert_providers
    }
  }
)

/**
 * Append a single API key to a provider (F-5). Body follows the official
 * AddProviderApiKeySchema ({ key, label? }). Mirrors the replace-api-keys
 * broadcast: the apiKeys field backs the list, detail, and api-keys read
 * models, so all three template endpoints are notified.
 */
adminRoutes.post(
  '/providers/:id/api-keys',
  async ({ params, body, set }) => {
    const parsed = AddProviderApiKeySchema.safeParse(body)
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    const updated = providerService.addApiKey(params.id, parsed.data.key, parsed.data.label)
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'projection', entityIds: [params.id] },
      { endpoint: '/providers/:providerId', entityIds: [params.id] },
      { endpoint: '/providers/:providerId/api-keys', entityIds: [params.id] }
    ])
    return updated
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: add provider API key',
      description: DOC_DESCRIPTIONS.admin_add_provider_api_key
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
    // M0-收尾 S2 (审计官 must-fix): the api-keys write mutates the provider's
    // apiKeys field, which backs the `/providers/:providerId/api-keys` and
    // `/providers/:providerId` read models. Broadcast all three so the list,
    // detail, and api-keys surfaces converge. Dispatch is exact-match on
    // endpoint, so we broadcast TEMPLATE paths + entityIds (the codebase-wide
    // convention) — not concrete paths, which would never match a renderer
    // subscription like `useDataChange('/providers/:providerId/api-keys', …)`.
    notifyDataApiDataChange([
      { endpoint: '/providers', kind: 'projection', entityIds: [params.id] },
      { endpoint: '/providers/:providerId', entityIds: [params.id] },
      { endpoint: '/providers/:providerId/api-keys', entityIds: [params.id] }
    ])
    return updated
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: replace provider API keys',
      description: DOC_DESCRIPTIONS.admin_replace_provider_api_keys
    }
  }
)

// ---------------------------------------------------------------------------
// F-6 — skills / MCP server management routes (managed admin, read-only).
// The underlying tables (agentGlobalSkillTable / mcpServerTable) already have
// official data Services (AgentGlobalSkillService / McpServerService), so these
// routes go through them — never direct sqlite (D20). Read-only: no broadcast.
// ---------------------------------------------------------------------------

/** List installed global skills (F-6). Read-only — no broadcast needed. */
adminRoutes.get(
  '/skills',
  async ({ query, set }) => {
    const parsed = ListSkillsQuerySchema.safeParse(query ?? {})
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    return agentGlobalSkillService.list(parsed.data)
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: list skills',
      description: DOC_DESCRIPTIONS.admin_list_skills
    }
  }
)

/** List MCP servers (F-6). Read-only — no broadcast needed. */
adminRoutes.get(
  '/mcp',
  async ({ query, set }) => {
    const parsed = ListMcpServersQuerySchema.safeParse(query ?? {})
    if (!parsed.success) {
      set.status = 400
      return { error: 'Bad Request: ' + parsed.error.issues.map((i) => i.message).join('; ') }
    }
    return mcpServerService.list(parsed.data)
  },
  {
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: list MCP servers',
      description: DOC_DESCRIPTIONS.admin_list_mcp_servers
    }
  }
)

/** Get a single MCP server by id (F-6). Read-only — no broadcast needed. */
adminRoutes.get(
  '/mcp/:id',
  async ({ params, set }) => {
    try {
      return mcpServerService.getById(params.id)
    } catch {
      set.status = 404
      return { error: `Not Found: McpServer ${params.id}` }
    }
  },
  {
    params: z.object({ id: z.string().min(1) }),
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Admin: get MCP server',
      description: DOC_DESCRIPTIONS.admin_get_mcp_server
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
      description: DOC_DESCRIPTIONS.admin_read_usage
    }
  }
)
