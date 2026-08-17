import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests that drive the real Elysia app via `app.handle(Request)`.
 *
 * They verify the idiomatic route wiring end-to-end: declarative schema
 * validation (auto-400), the per-dialect `onError` envelopes (OpenAI vs
 * Anthropic), auth short-circuiting, and `status()`-based responses.
 * (Knowledge route behaviour is covered in ../knowledge/__tests__.)
 */

// All mock fns live in vi.hoisted so the (hoisted) vi.mock factories can close
// over them without a TDZ error.
const { mockPreferenceGet, mockProcessMessage, mockGetModels, mockIsInternalRequestToken } = vi.hoisted(() => ({
  mockPreferenceGet: vi.fn<(key: string) => unknown>(() => 'test-key'),
  mockProcessMessage: vi.fn<(config: unknown) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  ),
  mockGetModels: vi.fn(async () => ({ object: 'list', data: [{ id: 'openai:gpt-4' }] })),
  mockIsInternalRequestToken: vi.fn((candidate: string | undefined) => candidate === 'internal-request-token')
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const overrides = {
    PreferenceService: { get: mockPreferenceGet },
    ApiGatewayService: { isInternalRequestToken: mockIsInternalRequestToken }
  }
  return mockApplicationFactory(overrides)
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
  }
}))

// Route `detail.description` fields hold i18n *keys*; openapiDocs.ts resolves them
// per request via `t()`. Stub `t` as `key::lang` (rather than a pure passthrough) so
// the docs tests below can assert the requested language actually reached translation
// — and so a key that never went through `t()` is visibly missing its `::lang` suffix
// — without needing the real catalog. `getAppLanguage`/`SUPPORTED_LANGUAGES` back the
// docs' default language + language-switcher list.
vi.mock('@main/i18n', () => ({
  t: (key: string, _params?: unknown, lang?: string) => (lang ? `${key}::${lang}` : key),
  getAppLanguage: () => 'en-US',
  SUPPORTED_LANGUAGES: ['en-US', 'zh-CN']
}))

// Heavy services are stubbed so building the app + exercising handlers never
// touches the real AiService / data layer.
vi.mock('../../proxyStream', () => ({
  processMessage: mockProcessMessage,
  default: { processMessage: mockProcessMessage }
}))

vi.mock('../../utils/models', () => ({
  getModels: mockGetModels
}))

// Knowledge routes use the v2 KB service (pulled in by buildApp); stubbed so
// building the app stays hermetic (knowledge behaviour tested separately).
vi.mock('@data/services/KnowledgeBaseService', () => ({
  knowledgeBaseService: { list: vi.fn(async () => ({ items: [], total: 0, page: 1 })), getById: vi.fn() }
}))

// ── M0 admin routes: stub the services + broadcast side-channel that
// adminRoutes.ts pulls in. These keep admin-route handlers hermetic (no real
// sqlite, no WindowManager broadcast) while letting tests assert the
// notification effect set that S2 aligns with the renderer subscriptions.
const {
  mockNotifyDataApiDataChange,
  mockProviderService,
  mockAgentService,
  mockAiUsageRecordService,
  mockCreateAgent,
  mockMcpServerService,
  mockAgentGlobalSkillService,
  mockAgentWorkspaceService
} = vi.hoisted(() => ({
  mockNotifyDataApiDataChange: vi.fn(),
  mockProviderService: {
    list: vi.fn<any>(() => []),
    create: vi.fn<any>((dto: any) => ({ id: dto.providerId, name: dto.name })),
    update: vi.fn<any>((id: string, _dto: any) => ({ id, name: 'updated' })),
    replaceApiKeys: vi.fn<any>((id: string) => ({ id, name: 'updated' })),
    delete: vi.fn<any>(() => undefined),
    batchUpsert: vi.fn<any>(() => undefined),
    addApiKey: vi.fn<any>((id: string) => ({ id, name: 'updated' }))
  },
  mockAgentService: {
    updateAgent: vi.fn<any>((id: string, _u: any) => ({ id, name: 'updated', instructions: 'i' })),
    listAgents: vi.fn<any>(() => ({ agents: [], total: 0 })),
    getAgent: vi.fn<any>((id: string) => ({ id, name: 'agent', instructions: 'i' })),
    deleteAgent: vi.fn<any>((_id: string) => ({ deleted: true, deletedSessionIds: [] })),
    reorderBatch: vi.fn<any>(() => undefined)
  },
  mockAiUsageRecordService: {
    list: vi.fn<any>(() => ({ records: [], total: 0 }))
  },
  mockCreateAgent: vi.fn<any>(async () => ({ id: 'agent-1', name: 'A', type: 'claude-code', model: 'openai:gpt-4' })),
  mockMcpServerService: {
    list: vi.fn<any>(() => ({ items: [], total: 0, page: 1 })),
    getById: vi.fn<any>((id: string) => ({ id, name: 'MCP A' }))
  },
  mockAgentGlobalSkillService: {
    list: vi.fn<any>(() => []),
    listAgentSessionWorkspacePaths: vi.fn<any>(() => [])
  },
  mockAgentWorkspaceService: {
    list: vi.fn<any>(() => [])
  }
}))

vi.mock('@data/dataApiDataChange', () => ({ notifyDataApiDataChange: mockNotifyDataApiDataChange }))
vi.mock('@data/services/ProviderService', () => ({ providerService: mockProviderService }))
vi.mock('@data/services/AgentService', () => ({ agentService: mockAgentService }))
vi.mock('@data/services/AiUsageRecordService', () => ({ aiUsageRecordService: mockAiUsageRecordService }))
vi.mock('@data/services/McpServerService', () => ({ mcpServerService: mockMcpServerService }))
vi.mock('@data/services/AgentGlobalSkillService', () => ({ agentGlobalSkillService: mockAgentGlobalSkillService }))
vi.mock('@data/services/AgentWorkspaceService', () => ({ agentWorkspaceService: mockAgentWorkspaceService }))
vi.mock('@main/ai/agents/createAgent', () => ({ createAgent: mockCreateAgent }))

import { buildApp } from '../../app'

const AUTH = { 'content-type': 'application/json', 'x-api-key': 'test-key' }

// F-3: the managed admin surface authenticates Bearer-only against the
// independent `feature.api_gateway.managed_key`. The preference mock returns
// 'test-key' for every key, so the admin Bearer token below must equal
// 'test-key' to authenticate (distinct from the employee api_key used by AUTH).
const AUTH_ADMIN = { 'content-type': 'application/json', authorization: 'Bearer test-key' }

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }))
}
function get(app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'GET', headers }))
}
function put(app: ReturnType<typeof buildApp>, path: string, body: unknown, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'PUT', headers, body: JSON.stringify(body) }))
}
function del(app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string> = AUTH) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'DELETE', headers }))
}
async function read(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() }
}

describe('API gateway routes (integration)', () => {
  let app: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPreferenceGet.mockReturnValue('test-key')
    app = buildApp()
  })

  describe('public routes', () => {
    it('GET /health → 200', async () => {
      const { status, body } = await read(await get(app, '/health', {}))
      expect(status).toBe(200)
      expect(body.status).toBe('ok')
    })

    it('GET / → 200 API info', async () => {
      const { status, body } = await read(await get(app, '/', {}))
      expect(status).toBe(200)
      expect(body.name).toBe('Cherry Studio API')
      expect(body.endpoints).toBeDefined()
    })

    it('OpenAPI spec advertises an absolute server URL from host/port', async () => {
      // Scalar renders curl examples against `servers[0].url`; an absolute URL
      // keeps the health-check example copyable (`curl http://.../health`)
      // instead of a bare relative path (`curl /health`).
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(body.servers).toEqual([{ url: 'http://127.0.0.1:23333' }])

      const custom = await read(await get(buildApp({ host: '0.0.0.0', port: 8080 }), '/openapi/json', {}))
      expect(custom.body.servers).toEqual([{ url: 'http://0.0.0.0:8080' }])
    })
  })

  describe('OpenAPI docs — per-language translation + switcher', () => {
    it('GET /openapi/json (no ?lang=) translates against the app language', async () => {
      const { status, body } = await read(await get(app, '/openapi/json', {}))
      expect(status).toBe(200)
      expect(body.info.description).toBe('apiGateway.docs.description::en-US')
      const health = body.paths['/health'].get
      expect(health.tags).toEqual(['Cherry Studio'])
      expect(health.summary).toBe('Health')
      expect(health.description).toBe('apiGateway.docs.operations.health::en-US')
    })

    it('groups endpoints by the upstream API they are compatible with, keeping canonical names', async () => {
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(body.tags.map((tag: { name: string }) => tag.name)).toEqual([
        'OpenAI API',
        'Anthropic API',
        'Gemini API',
        'Cherry Studio'
      ])
      // Tag names and operation summaries are upstream identifiers: never translated,
      // so generated clients keep stable module/method names. Only prose is localized.
      expect(body.tags[0].description).toBe('apiGateway.docs.tags.openai::en-US')
      expect(body.paths['/v1/chat/completions'].post.tags).toEqual(['OpenAI API'])
      expect(body.paths['/v1/chat/completions'].post.summary).toBe('Chat Completions')
      expect(body.paths['/v1/messages/'].post.tags).toEqual(['Anthropic API'])
      expect(body.paths['/v1/messages/'].post.summary).toBe('Messages')
    })

    it('routes every documented operation through translation (no raw i18n key survives)', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=zh-CN', {}))
      const operations = Object.values<any>(body.paths).flatMap((pathItem) => Object.values<any>(pathItem))
      expect(operations.length).toBeGreaterThan(0)
      for (const operation of operations) {
        // The stubbed `t()` appends `::lang`; a description a route declared but
        // openapiDocs.ts never resolved would show up here as a bare key.
        expect(operation.description).toMatch(/^apiGateway\.docs\.operations\.[a-z_]+::zh-CN$/)
      }
    })

    it('keeps the docs routes themselves out of the spec', async () => {
      const { body } = await read(await get(app, '/openapi/json', {}))
      expect(Object.keys(body.paths)).not.toContain('/openapi')
      expect(Object.keys(body.paths)).not.toContain('/openapi/json')
    })

    it('GET /openapi/json?lang=zh-CN translates against the requested language', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=zh-CN', {}))
      expect(body.info.description).toBe('apiGateway.docs.description::zh-CN')
      expect(body.paths['/health'].get.description).toBe('apiGateway.docs.operations.health::zh-CN')
    })

    it('GET /openapi/json?lang=not-a-real-language falls back to the app language', async () => {
      const { body } = await read(await get(app, '/openapi/json?lang=not-a-real-language', {}))
      expect(body.info.description).toBe('apiGateway.docs.description::en-US')
    })

    it('GET /openapi renders the description through t() (not a raw key) and points Scalar at the translated spec', async () => {
      const res = await get(app, '/openapi', {})
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      // The mocked `t()` embeds `::lang` on every call — the plain (untranslated) key never
      // appears without it, so this proves the <meta description> went through translation.
      expect(html).toContain('apiGateway.docs.description::en-US')
      expect(html).not.toContain('apiGateway.docs.description"')

      const configMatch = html.match(/data-configuration='(.+?)'/)
      expect(configMatch).toBeTruthy()
      const config = JSON.parse(configMatch![1])
      expect(config.url).toBe('http://localhost/openapi/json?lang=en-US')
      expect(config.localization).toEqual({ locale: 'en' })
    })

    it('pins the Scalar bundle and turns off its third-party "Ask AI" agent', async () => {
      const html = await (await get(app, '/openapi', {})).text()
      const config = JSON.parse(html.match(/data-configuration='(.+?)'/)![1])
      // Unpinned, an upstream release can change defaults (1.63.0 enabled Ask AI on
      // localhost) or break the toolbar the language switcher is inserted into.
      expect(config.cdn).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//)
      expect(config.version).toMatch(/^\d+\.\d+\.\d+$/)
      // Ask AI uploads the OpenAPI document to api.scalar.com — off unless a user
      // has been asked to accept that.
      expect(config.agent).toEqual({ disabled: true })
    })

    it('GET /openapi renders a language dropdown offering every supported language, defaulting to the app language', async () => {
      const html = await (await get(app, '/openapi', {})).text()
      expect(html).toContain(`<option value="en-US" selected>English</option>`)
      expect(html).toContain(`<option value="zh-CN">中文</option>`)
    })

    it('GET /openapi?lang=zh-CN renders Scalar chrome + the dropdown in the requested language', async () => {
      const html = await (await get(app, '/openapi?lang=zh-CN', {})).text()
      const config = JSON.parse(html.match(/data-configuration='(.+?)'/)![1])
      expect(config.url).toBe('http://localhost/openapi/json?lang=zh-CN')
      expect(config.localization).toEqual({ locale: 'zh-CN' })
      expect(html).toContain(`<option value="zh-CN" selected>中文</option>`)
    })
  })

  describe('auth', () => {
    it('rejects unauthenticated /v1 requests with 401', async () => {
      const { status, body } = await read(await get(app, '/v1/models', {}))
      expect(status).toBe(401)
      expect(body.error).toMatch(/Unauthorized/)
    })

    it('authenticates a /v1 request via the Authorization: Bearer header (@elysia/bearer)', async () => {
      const { status } = await read(await get(app, '/v1/models', { authorization: 'Bearer test-key' }))
      expect(status).toBe(200)
    })

    it('rejects a /v1 request with an invalid Bearer token (403)', async () => {
      const { status } = await read(await get(app, '/v1/models', { authorization: 'Bearer wrong-key' }))
      expect(status).toBe(403)
    })
  })

  describe('not found', () => {
    it('unmatched route → 404 Cherry REST envelope (does not crash onError)', async () => {
      const { status, body } = await read(await get(app, '/no-such-route', {}))
      expect(status).toBe(404)
      // App-level fallback uses the Cherry REST dialect: { error: { code, message } }.
      expect(body.error.code).toBe('NOT_FOUND')
      expect(body.error.type).toBeUndefined()
    })
  })

  describe("Cherry endpoints use Cherry's own REST error envelope", () => {
    it('knowledge search missing `query` → 422 REST envelope (not OpenAI dialect)', async () => {
      const { status, body } = await read(await post(app, '/v1/knowledge-bases/search', {}))
      expect(status).toBe(422)
      // REST dialect: { error: { code, message } } — no OpenAI `type`, no Anthropic top-level `type`.
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.type).toBeUndefined()
      expect(body.type).toBeUndefined()
    })
  })

  describe('validation → dialect-specific error envelopes', () => {
    it('chat completion missing `model` → OpenAI 400 envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(400)
      // OpenAI dialect: { error: { type, code } }, no top-level `type: 'error'`.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBe('invalid_request_error')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('responses missing `input` → OpenAI 400 envelope', async () => {
      const { status, body } = await read(await post(app, '/v1/responses', { model: 'openai:gpt-4' }))
      expect(status).toBe(400)
      expect(body.error.type).toBe('invalid_request_error')
    })

    it('messages missing `messages` → Anthropic 400 envelope', async () => {
      const { status, body } = await read(await post(app, '/v1/messages', { model: 'anthropic:claude' }))
      expect(status).toBe(400)
      // Anthropic dialect: { type: 'error', error: { type, message } }.
      expect(body.type).toBe('error')
      expect(body.error.type).toBe('invalid_request_error')
    })
  })

  describe('valid requests reach the handler', () => {
    it('valid chat completion passes validation and calls processMessage', async () => {
      const { status, body } = await read(
        await post(app, '/v1/chat/completions', { model: 'openai:gpt-4', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(mockProcessMessage).toHaveBeenCalledOnce()
    })

    it('ignores the internal Fast header from a public API-key client', async () => {
      await read(
        await post(
          app,
          '/v1/messages',
          { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] },
          { ...AUTH, 'x-cherry-fast-mode': 'true' }
        )
      )

      expect(mockProcessMessage).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: false }))
    })

    it('accepts Fast only with the process-local internal request token', async () => {
      await read(
        await post(
          app,
          '/v1/messages',
          { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] },
          {
            ...AUTH,
            'x-cherry-fast-mode': 'true',
            'x-cherry-internal-request-token': 'internal-request-token'
          }
        )
      )

      expect(mockProcessMessage).toHaveBeenLastCalledWith(expect.objectContaining({ fastMode: true }))
    })

    it('GET /v1/models returns the model list', async () => {
      const { status, body } = await read(await get(app, '/v1/models'))
      expect(status).toBe(200)
      expect(body.object).toBe('list')
      expect(body.data).toHaveLength(1)
    })
  })

  describe('thrown provider errors → dialect status mapping (not a flat 500)', () => {
    const chat = { model: 'openai:gpt-4', messages: [{ role: 'user', content: 'hi' }] }

    it('chat: a 429 SerializedError → OpenAI 429 envelope, message preserved, extras dropped', async () => {
      mockProcessMessage.mockRejectedValueOnce({
        name: 'AI_APICallError',
        message: 'rate limited',
        stack: 'secret stack',
        statusCode: 429,
        url: 'https://provider/v1',
        requestBodyValues: { prompt: 'SECRET PROMPT' },
        responseBody: 'secret body'
      })
      const { status, body } = await read(await post(app, '/v1/chat/completions', chat))
      expect(status).toBe(429)
      expect(body.error.type).toBe('rate_limit_error')
      expect(body.error.message).toBe('rate limited')
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('secret stack')
      expect(serialized).not.toContain('SECRET PROMPT')
      expect(serialized).not.toContain('secret body')
      expect(serialized).not.toContain('https://provider/v1')
    })

    it('chat: a 403 SerializedError → OpenAI 403 forbidden envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'no access', stack: null, statusCode: 403 })
      const { status, body } = await read(await post(app, '/v1/chat/completions', chat))
      expect(status).toBe(403)
      expect(body.error.type).toBe('forbidden_error')
    })

    it('messages: a 401 SerializedError → Anthropic 401 authentication envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'bad key', stack: null, statusCode: 401 })
      const { status, body } = await read(
        await post(app, '/v1/messages', { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(401)
      expect(body.type).toBe('error') // Anthropic envelope
      expect(body.error.type).toBe('authentication_error')
      expect(body.error.message).toBe('bad key')
    })

    it('messages: a non-retryable provider 400 → Anthropic 400 invalid-request envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({
        name: 'AI_APICallError',
        message: 'Maximum context length exceeded',
        stack: null,
        statusCode: 400,
        isRetryable: false
      })
      const { status, body } = await read(
        await post(app, '/v1/messages', { model: 'anthropic:claude', messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(status).toBe(400)
      expect(body.type).toBe('error')
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.message).toBe('Maximum context length exceeded')
    })

    it('responses: an internal error with no status → 500 with the message gated out', async () => {
      mockProcessMessage.mockRejectedValueOnce(new Error('internal detail leak'))
      const { status, body } = await read(await post(app, '/v1/responses', { model: 'openai:gpt-4', input: 'hi' }))
      expect(status).toBe(500)
      expect(body.error.type).toBe('server_error')
      // NODE_ENV !== 'development' under test → internal messages are not leaked.
      expect(body.error.message).toBe('Internal server error')
    })
  })

  describe('Gemini (/v1beta) routes', () => {
    const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    const GOOG_AUTH = { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' }

    it('generateContent: model + non-streaming derived from the URL, routed with gemini formats', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody)
      )
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(mockProcessMessage).toHaveBeenCalledOnce()
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: 'deepseek:deepseek-chat',
        streaming: false,
        inputFormat: 'gemini',
        outputFormat: 'gemini'
      })
    })

    it('streamGenerateContent: preserves a slashed apiModelId and sets streaming=true', async () => {
      // The gateway model addressing "providerId:apiModelId" can contain both a
      // colon and a slash (aggregator ids like `agent/deepseek-v4-flash`); the
      // wildcard route must keep the whole model intact and split off only the method.
      await read(await post(app, '/v1beta/models/618d8838:agent/deepseek-v4-flash:streamGenerateContent', geminiBody))
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: '618d8838:agent/deepseek-v4-flash',
        streaming: true,
        inputFormat: 'gemini'
      })
    })

    it('strips the gemini-cli sentinel suffix off the model before routing', async () => {
      // Cherry hands gemini-cli the address with an `@cherry` suffix so its model
      // normalization can't rewrite names ending in "flash"; the route must strip it.
      await read(
        await post(app, '/v1beta/models/618d8838:agent/deepseek-v4-flash@cherry:streamGenerateContent', geminiBody)
      )
      expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
        modelString: '618d8838:agent/deepseek-v4-flash',
        streaming: true
      })
    })

    it('rejects a model still ending in the reserved @cherry suffix after one strip → 400', async () => {
      // The sentinel is reserved: the route strips exactly one trailing `@cherry`, so a model that
      // STILL ends in it (a real id ending in the reserved marker, or a doubled sentinel) is
      // ambiguous and never advertised by GET /models — reject rather than route to the wrong id.
      const { status, body } = await read(
        await post(app, '/v1beta/models/weird:model@cherry@cherry:generateContent', geminiBody)
      )
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('countTokens: returns a local estimate without calling processMessage', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:countTokens', geminiBody)
      )
      expect(status).toBe(200)
      expect(typeof body.totalTokens).toBe('number')
      expect(body.totalTokens).toBeGreaterThan(0)
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    // Media is now counted (converted → shared walker, or the provider's remote count) rather
    // than rejected — the estimate reflects what the provider actually receives.
    it.each([
      ['inlineData', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
      ['fileData', { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/f.pdf' } }]
    ])('countTokens with %s media → 200 with a token estimate', async (_kind, mediaPart) => {
      const mediaBody = { contents: [{ role: 'user', parts: [mediaPart] }] }
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:countTokens', mediaBody)
      )
      expect(status).toBe(200)
      expect(typeof body.totalTokens).toBe('number')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('unsupported method → 400 Google INVALID_ARGUMENT envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:embedContent', geminiBody)
      )
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(mockProcessMessage).not.toHaveBeenCalled()
    })

    it('rejects unauthenticated /v1beta requests with a 401 Google UNAUTHENTICATED envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, {
          'content-type': 'application/json'
        })
      )
      expect(status).toBe(401)
      // Auth short-circuits before the handler, but must still speak the Google dialect.
      expect(body.error.code).toBe(401)
      expect(body.error.status).toBe('UNAUTHENTICATED')
      expect(typeof body.error.message).toBe('string')
      // Not the OpenAI/Anthropic shapes.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBeUndefined()
    })

    it('rejects an invalid /v1beta key with a 403 Google PERMISSION_DENIED envelope', async () => {
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, {
          'content-type': 'application/json',
          'x-goog-api-key': 'wrong-key'
        })
      )
      expect(status).toBe(403)
      expect(body.error.code).toBe(403)
      expect(body.error.status).toBe('PERMISSION_DENIED')
    })

    it('authenticates via the x-goog-api-key header', async () => {
      const { status } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody, GOOG_AUTH)
      )
      expect(status).toBe(200)
    })

    it('authenticates via the ?key= query param', async () => {
      const { status } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent?key=test-key', geminiBody, {
          'content-type': 'application/json'
        })
      )
      expect(status).toBe(200)
    })

    it('missing `contents` → 400 Google envelope (not OpenAI/Anthropic dialect)', async () => {
      const { status, body } = await read(await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', {}))
      expect(status).toBe(400)
      expect(body.error.status).toBe('INVALID_ARGUMENT')
      expect(body.error.code).toBe(400)
      // Not the OpenAI/Anthropic shapes.
      expect(body.type).toBeUndefined()
      expect(body.error.type).toBeUndefined()
    })

    it('a thrown 429 provider error → Google RESOURCE_EXHAUSTED envelope', async () => {
      mockProcessMessage.mockRejectedValueOnce({ name: 'Error', message: 'rate limited', stack: null, statusCode: 429 })
      const { status, body } = await read(
        await post(app, '/v1beta/models/deepseek:deepseek-chat:generateContent', geminiBody)
      )
      expect(status).toBe(429)
      expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
      expect(body.error.message).toBe('rate limited')
    })
  })

  describe('admin routes (M0 managed surface)', () => {
    beforeEach(() => {
      // Admin routes authenticate via the same `scoped` x-api-key / bearer guard as
      // `/v1`; the default preference mock returns 'test-key', which matches AUTH.
      mockNotifyDataApiDataChange.mockClear()
    })

    it('registers the admin routes in the OpenAPI spec', async () => {
      const { body } = await read(await get(app, '/openapi/json', {}))
      for (const path of [
        '/v1/admin/providers',
        '/v1/admin/providers/{id}',
        '/v1/admin/providers/{id}/api-keys',
        '/v1/admin/agents',
        '/v1/admin/agents/{id}',
        '/v1/admin/agents/reorder',
        '/v1/admin/providers/batchUpsert',
        '/v1/admin/usage',
        '/v1/admin/skills',
        '/v1/admin/mcp',
        '/v1/admin/mcp/{id}',
        '/v1/admin/agents/{id}/files'
      ]) {
        expect(body.paths[path]).toBeDefined()
      }
    })

    it('rejects an unauthenticated admin request with 401', async () => {
      const { status, body } = await read(await get(app, '/v1/admin/providers', {}))
      expect(status).toBe(401)
      expect(body.error).toMatch(/Unauthorized/)
      expect(mockProviderService.list).not.toHaveBeenCalled()
    })

    it('rejects an admin request with only an x-api-key header (401, F-3 Bearer-only)', async () => {
      const { status } = await read(await get(app, '/v1/admin/providers', { 'x-api-key': 'wrong-key' }))
      expect(status).toBe(401)
    })

    it('GET /v1/admin/providers lists providers via the service', async () => {
      mockProviderService.list.mockReturnValueOnce([{ id: 'openai', name: 'OpenAI' }])
      const { status, body } = await read(await get(app, '/v1/admin/providers', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body).toEqual([{ id: 'openai', name: 'OpenAI' }])
      expect(mockProviderService.list).toHaveBeenCalledOnce()
    })

    it('POST /v1/admin/providers creates + broadcasts collection and detail endpoints', async () => {
      const { status, body } = await read(
        await post(app, '/v1/admin/providers', { providerId: 'openai', name: 'OpenAI' }, AUTH_ADMIN)
      )
      expect(status).toBe(200)
      expect(body.id).toBe('openai')
      expect(mockProviderService.create).toHaveBeenCalledOnce()
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId', entityIds: ['openai'] }
      ])
    })

    it('PUT /v1/admin/providers/:id updates + broadcasts collection and detail endpoints', async () => {
      const { status } = await read(await put(app, '/v1/admin/providers/openai', { name: 'OpenAI v2' }, AUTH_ADMIN))
      expect(status).toBe(200)
      expect(mockProviderService.update).toHaveBeenCalledWith('openai', { name: 'OpenAI v2' })
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId', entityIds: ['openai'] }
      ])
    })

    it('PUT /v1/admin/providers/:id/api-keys broadcasts list + detail + api-keys (S2 alignment)', async () => {
      const { status, body } = await read(
        await put(
          app,
          '/v1/admin/providers/openai/api-keys',
          {
            keys: [{ key: 'sk-123', id: 'k1', isEnabled: true }]
          },
          AUTH_ADMIN
        )
      )
      expect(status).toBe(200)
      expect(body.id).toBe('openai')
      expect(mockProviderService.replaceApiKeys).toHaveBeenCalledWith('openai', [
        { key: 'sk-123', id: 'k1', isEnabled: true }
      ])
      // S2 must-fix: the api-keys write must notify every surface that has a
      // renderer useDataChange subscription — list, detail, api-keys. The
      // effect endpoints are TEMPLATE paths + entityIds (codebase convention),
      // because dispatchDataChange does exact endpoint match.
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId/api-keys', entityIds: ['openai'] }
      ])
    })

    it('GET /v1/admin/usage reads usage via the service', async () => {
      mockAiUsageRecordService.list.mockReturnValueOnce({ records: [{ providerId: 'openai' }], total: 1 })
      const { status, body } = await read(await get(app, '/v1/admin/usage', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.records).toHaveLength(1)
      expect(mockAiUsageRecordService.list).toHaveBeenCalledOnce()
    })

    it('POST /v1/admin/agents creates + broadcasts collection and detail endpoints', async () => {
      const { status, body } = await read(
        await post(app, '/v1/admin/agents', { name: 'AgentA', type: 'claude-code', model: 'openai::gpt-4' }, AUTH_ADMIN)
      )
      expect(status).toBe(200)
      expect(body.id).toBe('agent-1')
      expect(mockCreateAgent).toHaveBeenCalledOnce()
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/agents', kind: 'projection', entityIds: ['agent-1'] },
        { endpoint: '/agents/:agentId', entityIds: ['agent-1'] }
      ])
    })

    it('PUT /v1/admin/agents/:id updates + broadcasts collection and detail endpoints', async () => {
      const { status, body } = await read(await put(app, '/v1/admin/agents/agent-1', { name: 'A2' }, AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.id).toBe('agent-1')
      expect(mockAgentService.updateAgent).toHaveBeenCalledWith('agent-1', { name: 'A2' })
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/agents', kind: 'projection', entityIds: ['agent-1'] },
        { endpoint: '/agents/:agentId', entityIds: ['agent-1'] }
      ])
    })

    it('GET /v1/admin/agents lists agents via the service (F-4)', async () => {
      mockAgentService.listAgents.mockReturnValueOnce({ agents: [{ id: 'a1', name: 'A' }], total: 1 })
      const { status, body } = await read(await get(app, '/v1/admin/agents', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.agents).toHaveLength(1)
      expect(mockAgentService.listAgents).toHaveBeenCalledOnce()
    })

    it('GET /v1/admin/agents/:id returns the agent via the service (F-4)', async () => {
      mockAgentService.getAgent.mockReturnValueOnce({ id: 'a1', name: 'A', instructions: 'i' })
      const { status, body } = await read(await get(app, '/v1/admin/agents/a1', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.id).toBe('a1')
      expect(mockAgentService.getAgent).toHaveBeenCalledWith('a1')
    })

    it('GET /v1/admin/agents/:id returns 404 when the agent is absent (F-4)', async () => {
      mockAgentService.getAgent.mockReturnValueOnce(null)
      const { status } = await read(await get(app, '/v1/admin/agents/nope', AUTH_ADMIN))
      expect(status).toBe(404)
    })

    it('DELETE /v1/admin/agents/:id deletes + broadcasts collection and detail (F-4)', async () => {
      const { status, body } = await read(await del(app, '/v1/admin/agents/a1', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.deleted).toBe(true)
      expect(mockAgentService.deleteAgent).toHaveBeenCalledWith('a1')
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/agents', kind: 'projection', entityIds: ['a1'] },
        { endpoint: '/agents/:agentId', entityIds: ['a1'] }
      ])
    })

    it('DELETE /v1/admin/agents/:id returns 404 when the agent is absent (F-4)', async () => {
      mockAgentService.deleteAgent.mockReturnValueOnce({ deleted: false })
      const { status } = await read(await del(app, '/v1/admin/agents/nope', AUTH_ADMIN))
      expect(status).toBe(404)
    })

    it('POST /v1/admin/agents/reorder persists order + broadcasts the collection (F-4)', async () => {
      const { status } = await read(
        await post(
          app,
          '/v1/admin/agents/reorder',
          { moves: [{ id: 'a1', anchor: { position: 'first' } }] },
          AUTH_ADMIN
        )
      )
      expect(status).toBe(200)
      expect(mockAgentService.reorderBatch).toHaveBeenCalledWith([{ id: 'a1', anchor: { position: 'first' } }])
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/agents', kind: 'projection', entityIds: ['a1'] }
      ])
    })

    it('DELETE /v1/admin/providers/:id deletes + broadcasts collection and detail (F-5)', async () => {
      const { status, body } = await read(await del(app, '/v1/admin/providers/custom', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.deleted).toBe(true)
      expect(mockProviderService.delete).toHaveBeenCalledWith('custom')
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: ['custom'] },
        { endpoint: '/providers/:providerId', entityIds: ['custom'] }
      ])
    })

    it('POST /v1/admin/providers/batchUpsert upserts + broadcasts the collection (F-5)', async () => {
      const { status } = await read(
        await post(app, '/v1/admin/providers/batchUpsert', [{ providerId: 'p1', name: 'P1' }], AUTH_ADMIN)
      )
      expect(status).toBe(200)
      expect(mockProviderService.batchUpsert).toHaveBeenCalledWith([{ providerId: 'p1', name: 'P1' }])
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: [] }
      ])
    })

    it('POST /v1/admin/providers/:id/api-keys adds a key + broadcasts list/detail/api-keys (F-5)', async () => {
      const { status, body } = await read(
        await post(app, '/v1/admin/providers/openai/api-keys', { key: 'sk-456', label: 'ops' }, AUTH_ADMIN)
      )
      expect(status).toBe(200)
      expect(body.id).toBe('openai')
      expect(mockProviderService.addApiKey).toHaveBeenCalledWith('openai', 'sk-456', 'ops')
      expect(mockNotifyDataApiDataChange).toHaveBeenCalledWith([
        { endpoint: '/providers', kind: 'projection', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId', entityIds: ['openai'] },
        { endpoint: '/providers/:providerId/api-keys', entityIds: ['openai'] }
      ])
    })

    it('GET /v1/admin/skills lists skills via the service (F-6, read-only, no broadcast)', async () => {
      mockAgentGlobalSkillService.list.mockReturnValueOnce([{ id: 's1', name: 'Skill A' }])
      const { status, body } = await read(await get(app, '/v1/admin/skills', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body).toEqual([{ id: 's1', name: 'Skill A' }])
      expect(mockAgentGlobalSkillService.list).toHaveBeenCalledOnce()
      expect(mockNotifyDataApiDataChange).not.toHaveBeenCalled()
    })

    it('GET /v1/admin/mcp lists MCP servers via the service (F-6, read-only, no broadcast)', async () => {
      mockMcpServerService.list.mockReturnValueOnce({ items: [{ id: 'm1', name: 'MCP A' }], total: 1, page: 1 })
      const { status, body } = await read(await get(app, '/v1/admin/mcp', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.items).toHaveLength(1)
      expect(mockMcpServerService.list).toHaveBeenCalledOnce()
      expect(mockNotifyDataApiDataChange).not.toHaveBeenCalled()
    })

    it('GET /v1/admin/mcp/:id returns the MCP server via the service (F-6)', async () => {
      mockMcpServerService.getById.mockReturnValueOnce({ id: 'm1', name: 'MCP A' })
      const { status, body } = await read(await get(app, '/v1/admin/mcp/m1', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.id).toBe('m1')
      expect(mockMcpServerService.getById).toHaveBeenCalledWith('m1')
    })

    it('GET /v1/admin/mcp/:id returns 404 when the MCP server is absent (F-6)', async () => {
      mockMcpServerService.getById.mockImplementationOnce(() => {
        throw new Error('not found')
      })
      const { status } = await read(await get(app, '/v1/admin/mcp/nope', AUTH_ADMIN))
      expect(status).toBe(404)
    })

    it('GET /v1/admin/agents/:id/files returns 404 when the agent is absent (F-7b)', async () => {
      mockAgentService.getAgent.mockReturnValueOnce(null)
      const { status } = await read(await get(app, '/v1/admin/agents/nope/files', AUTH_ADMIN))
      expect(status).toBe(404)
    })

    it('GET /v1/admin/agents/:id/files returns empty when the agent has no workspace (F-7b)', async () => {
      mockAgentService.getAgent.mockReturnValueOnce({ id: 'a1', name: 'A', instructions: 'i' })
      mockAgentGlobalSkillService.listAgentSessionWorkspacePaths.mockReturnValueOnce([])
      const { status, body } = await read(await get(app, '/v1/admin/agents/a1/files', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.agentId).toBe('a1')
      expect(body.accessiblePaths).toEqual([])
      expect(body.entries).toEqual([])
    })

    it('GET /v1/admin/agents/:id/files?file= rejects traversal outside accessible paths (F-7b)', async () => {
      mockAgentService.getAgent.mockReturnValueOnce({ id: 'a1', name: 'A', instructions: 'i' })
      mockAgentGlobalSkillService.listAgentSessionWorkspacePaths.mockReturnValueOnce(['/tmp/ws-a1'])
      const { status } = await read(await get(app, '/v1/admin/agents/a1/files?file=/etc/passwd', AUTH_ADMIN))
      expect(status).toBe(404)
    })

    it('GET /v1/admin/agents/:id/files enumerates a workspace dir via the real FS (F-7b)', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const ws = mkdtempSync(join(tmpdir(), 'admin-f7b-'))
      writeFileSync(join(ws, 'notes.md'), 'hello')
      writeFileSync(join(ws, 'data.txt'), 'x')

      mockAgentService.getAgent.mockReturnValueOnce({ id: 'a1', name: 'A', instructions: 'i' })
      mockAgentGlobalSkillService.listAgentSessionWorkspacePaths.mockReturnValueOnce([ws])

      const { status, body } = await read(await get(app, '/v1/admin/agents/a1/files', AUTH_ADMIN))
      expect(status).toBe(200)
      expect(body.accessiblePaths).toEqual([ws])
      const names = body.entries.map((e: { name: string }) => e.name)
      expect(names).toContain('notes.md')
      expect(names).toContain('data.txt')
    })

    it('GET /v1/admin/agents/:id/files?file= reads file content within an accessible path (F-7b)', async () => {
      const { mkdtempSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const ws = mkdtempSync(join(tmpdir(), 'admin-f7b-read-'))
      writeFileSync(join(ws, 'notes.md'), 'hello content')

      mockAgentService.getAgent.mockReturnValueOnce({ id: 'a1', name: 'A', instructions: 'i' })
      mockAgentGlobalSkillService.listAgentSessionWorkspacePaths.mockReturnValueOnce([ws])

      const { status, body } = await read(
        await get(app, `/v1/admin/agents/a1/files?file=${encodeURIComponent(join(ws, 'notes.md'))}`, AUTH_ADMIN)
      )
      expect(status).toBe(200)
      expect(body.content).toBe('hello content')
    })
  })
})
