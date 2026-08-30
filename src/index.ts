/**
 * Host half of dsh-router — a simplified 9router.
 *
 * dsh-router IS the router: it exposes an OpenAI-compatible `/v1/*` endpoint
 * on the DSH web server (http://localhost:3080/v1), and routes requests to
 * internal suppliers.
 *
 * Routes:
 *   POST /v1/chat/completions                 OpenAI-compatible chat (stream + non-stream)
 *   GET  /v1/models                           OpenAI-compatible model list
 *   GET  /router/api/health                   router status (panel)
 *   GET  /router/api/status                   supplier accounts (panel)
 *   GET  /router/api/models                   merged model list (panel)
 *   GET  /router/api/combos                   combo fallback chains (panel)
 *   GET  /router/api/keys                     list keys (masked)
 *   POST /router/api/keys                     create key {name}
 *   DELETE /router/api/keys/:id               delete key
 *   PATCH /router/api/keys/:id                toggle key {isActive}
 *   GET  /router/api/settings                 { requireApiKey }
 *   PATCH /router/api/settings                { requireApiKey }
 *   POST /router/api/suppliers/:id/login                  generate login URL
 *   POST /router/api/suppliers/:id/login/callback         {callbackUrl} → add account
 *   GET  /router/api/suppliers/:id/models                 models with enabled state
 *   PATCH /router/api/suppliers/:id/models/:mid           {enabled}
 *
 * `/v1/*` auth: gated by KeysStore.requireApiKey — when on, Bearer must be an
 * active library key or TW2A_API_KEY env. `/router/api/*` is same-origin, no auth.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { ROUTER_API_BASE } from './shared.ts'
import { Router } from './router/index.ts'
import { RouterAdapter } from './llm/adapter.ts'
import { KeysStore } from './keys.ts'
import { loadSuppliers, wrapModule, type LoadedSupplier } from './suppliers/loader.ts'
import { supplierRoutes } from './suppliers/registry.ts'
import type { SupplierEnv, SupplierModule } from './suppliers/contract.ts'
import { SupplierConfigStore } from './supplier-config.ts'
import { CredentialStore } from './credential-store.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-router'

/** Services required before mounting: the webserver (routes) + llm (设置-模型). */
export const inject = ['webServer', 'llm']

/** Minimal shape of the webServer service face used here. */
interface WebServerRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
interface WebServer {
  register: (route: WebServerRoute) => () => void
}

/** Minimal shape of the llm service faces used here (设置-模型 提供方/模型目录). */
interface LlmConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}
interface LlmModelDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
  signal?: AbortSignal
}
interface LlmDiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}
interface Llm {
  registerConfigurableProviders: (entries: readonly LlmConfigurableProvider[]) => () => void
  listConfigurableProviders: () => LlmConfigurableProvider[]
  listProviders: () => Array<{ id: string; name: string }>
  registerModelDiscovery: (
    settingsNs: string,
    discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>,
  ) => () => void
  registerAdapter: (providers: readonly string[], adapter: unknown) => () => void
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Plugin body. */
export function apply(rawContext: unknown): void {
  const ctx = rawContext as {
    get: (key: string) => unknown
    on: (name: string, listener: (...args: unknown[]) => void) => unknown
    webServer: WebServer
    llm?: Llm
    logger: { info: (message: string) => void; warn: (message: string) => void }
    effect: (fn: () => () => void, label?: string) => void
    inject: (services: string[], callback: (sctx: unknown) => void) => void
  }
  const log = (msg: string): void => ctx.logger.info(`[dsh-router] ${msg}`)

  const stateFile = process.env.TW2A_STATE_FILE ?? 'data/state.json'
  const store = new SupplierConfigStore(stateFile)
  const credentials = new CredentialStore(process.env.TW2A_AUTH_DIR ?? join(dirname(stateFile), 'auths'))
  const router = new Router(stateFile, store, log)

  const keys = new KeysStore(stateFile)

  const disposers: Array<() => void> = []
  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  // ---- 供应商注册表：内置 + 用户自定义 js + 外部插件供应商 ----
  const loadedSuppliers: LoadedSupplier[] = []
  /** 每个供应商的 webServer 路由注销函数（注销时单独清理）。 */
  const supplierDisposers = new Map<string, Array<() => void>>()
  const registerSupplierRoutes = (loaded: LoadedSupplier): void => {
    const dis: Array<() => void> = []
    for (const r of supplierRoutes(ROUTER_API_BASE, loaded, store, router)) {
      dis.push(ctx.webServer.register(r))
    }
    supplierDisposers.set(loaded.supplier.id, dis)
    log(`supplier routes registered: ${loaded.supplier.id}`)
  }
  /** 注销一个供应商（路由 + 路由器 + 列表）。 */
  const unregisterSupplier = (id: string): void => {
    const i = loadedSuppliers.findIndex((l) => l.supplier.id === id)
    if (i < 0) return
    const [loaded] = loadedSuppliers.splice(i, 1)
    for (const dispose of supplierDisposers.get(id) ?? []) dispose()
    supplierDisposers.delete(id)
    router.removeSupplier(id)
    loaded?.supplier.dispose()
    log(`supplier unregistered: ${id}`)
  }

  // 内置 + 用户 + 外部插件供应商（异步加载，完成后注册路由 + 加入路由器）
  const dataDir = dirname(stateFile)
  const registerLoaded = (loaded: LoadedSupplier): void => {
    loadedSuppliers.push(loaded)
    router.add(loaded.supplier)
    registerSupplierRoutes(loaded)
  }
  /** 当前由 router.suppliers service 加载的供应商 id（外部插件卸载时全部注销）。 */
  let externalSupplierIds: string[] = []
  const loadExternal = (suppliers: Record<string, (env: SupplierEnv) => SupplierModule>): void => {
    for (const [sid, factory] of Object.entries(suppliers)) {
      if (externalSupplierIds.includes(sid)) continue // 已加载（internal/service + inject 可能重复触发）
      try {
        const module = factory({ dataDir, log, store, credentials })
        const loaded = wrapModule(module, { dataDir, log, store, credentials }, `service router.suppliers.${sid}`)
        registerLoaded(loaded)
        externalSupplierIds.push(loaded.supplier.id)
        log(`external supplier loaded: ${sid}`)
      } catch (err) {
        ctx.logger.warn(`[dsh-router] external supplier ${sid} load failed: ${(err as Error).message}`)
      }
    }
  }
  const unloadExternal = (): void => {
    for (const id of externalSupplierIds.splice(0)) unregisterSupplier(id)
  }
  // 外部插件供应商（cordis service，其它 DSH 插件提供）。
  // 监听 internal/service：service 提供时加载，移除（插件卸载）时注销——不依赖重启。
  ctx.on('internal/service', (name: unknown, value: unknown) => {
    if (name !== 'router.suppliers') return
    if (value) {
      loadExternal(value as Record<string, (env: SupplierEnv) => SupplierModule>)
    } else {
      unloadExternal()
    }
  })
  // 兼容 cordis inject（service 已提供但 internal/service 事件可能早于本监听注册）
  ctx.inject(['router.suppliers'], (sctx) => {
    const c = sctx as { get?: (key: string) => unknown; router?: { suppliers?: Record<string, (env: SupplierEnv) => SupplierModule> } }
    const service = (c.get?.('router.suppliers') ?? c.router?.suppliers) as Record<string, (env: SupplierEnv) => SupplierModule> | undefined
    if (service) loadExternal(service)
  })
  void (async () => {
    try {
      const userDir = join(process.env.DSH_PROFILE_DIR ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'web'), 'suppliers')
      const { suppliers, errors } = await loadSuppliers({
        builtinDir: join(import.meta.dirname, 'suppliers'), // 内置 js（opencode 等）
        userDir,
        dataDir,
        store,
        credentials,
        log,
      })
      for (const err of errors) ctx.logger.warn(`[dsh-router] ${err.error}`)
      for (const loaded of suppliers) registerLoaded(loaded)
      log(`suppliers loaded: ${suppliers.map((s) => s.supplier.id).join(', ') || '(none)'}`)
    } catch (err) {
      ctx.logger.warn(`[dsh-router] suppliers load failed: ${(err as Error).message}`)
    }
  })()

  // ---- /v1/* (OpenAI-compatible, Bearer auth via KeysStore) ----

  const withV1Auth = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const authz = req.headers.authorization ?? ''
      const prefix = 'Bearer '
      const bearer = authz.length >= prefix.length && authz.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
        ? authz.slice(prefix.length)
        : undefined
      if (!keys.verify(bearer)) {
        writeJson(res, 401, { error: { message: 'missing or invalid API key', type: 'api_error', code: 'invalid_api_key' } })
        return
      }
      await handler(req, res)
    }
  }

  route('/v1/models', withV1Auth(async (_req, res) => {
    const models = await router.listModels()
    writeJson(res, 200, { object: 'list', data: models })
  }))

  route('/v1/chat/completions', withV1Auth(async (req, res) => {
    let body: string
    try {
      body = await readBody(req, 8 << 20)
    } catch {
      writeJson(res, 413, { error: { message: 'request body too large', type: 'api_error', code: 'request_too_large' } })
      return
    }
    let peek: { stream?: boolean; model?: string }
    try {
      peek = JSON.parse(body) as { stream?: boolean; model?: string }
    } catch {
      writeJson(res, 400, { error: { message: 'invalid JSON body', type: 'api_error', code: 'invalid_request' } })
      return
    }
    await router.chatCompletions(
      { rawBody: body, stream: !!peek.stream, model: typeof peek.model === 'string' ? peek.model : '' },
      res,
    )
  }))

  // ---- /router/api/* (panel, same-origin) ----

  route(`${ROUTER_API_BASE}/health`, (_req, res) => {
    const { suppliers } = router.status()
    writeJson(res, 200, {
      ok: true,
      suppliers: suppliers.map((s) => {
        const loaded = loadedSuppliers.find((l) => l.supplier.id === s.id)
        return {
          id: s.id,
          name: s.name,
          icon: loaded?.supplier.icon,
          capabilities: loaded ? [...loaded.capabilities] : [],
          source: loaded?.source ?? 'external',
        }
      }),
    })
  })

  route(`${ROUTER_API_BASE}/status`, (_req, res) => {
    const { suppliers } = router.status()
    const accounts = suppliers.flatMap((s) =>
      s.accounts.map((a) => ({ ...a, supplier: s.id })),
    )
    writeJson(res, 200, { ok: true, accounts })
  })

  route(`${ROUTER_API_BASE}/models`, async (_req, res) => {
    try {
      const models = await router.listModels()
      writeJson(res, 200, { ok: true, models })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: (error as Error).message })
    }
  })

  route(`${ROUTER_API_BASE}/combos`, async (_req, res) => {
    const [combos, groups] = await Promise.all([
      router.combos(),
      router.supplierModels().catch(() => []),
    ])
    writeJson(res, 200, { ok: true, combos, groups, aliases: router.aliases() })
  })

  route(`${ROUTER_API_BASE}/combos/create`, async (req, res) => {
    let body: { name?: string; strategy?: string; models?: string[] }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { name?: string; strategy?: string; models?: string[] }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const result = router.createCombo(body.name ?? '', body.strategy ?? 'fallback', body.models ?? [])
    writeJson(res, result.ok ? 200 : 400, result)
  })

  route(`${ROUTER_API_BASE}/combos/update`, async (req, res) => {
    let body: { id?: string; name?: string; strategy?: string; models?: string[] }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { id?: string; name?: string; strategy?: string; models?: string[] }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const result = router.updateCombo(body.id ?? '', body.name ?? '', body.strategy ?? 'fallback', body.models ?? [])
    writeJson(res, result.ok ? 200 : 400, result)
  })

  route(`${ROUTER_API_BASE}/combos/remove`, async (req, res) => {
    let body: { id?: string }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { id?: string }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const result = router.removeCombo(body.id ?? '')
    writeJson(res, result.ok ? 200 : 400, result)
  })

  // ---- 端点与密钥：keys + settings ----

  route(`${ROUTER_API_BASE}/keys`, async (req, res) => {
    if (req.method === 'POST') {
      let body: { name?: string }
      try {
        body = JSON.parse(await readBody(req, 64 << 10)) as { name?: string }
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const { key } = keys.create(typeof body.name === 'string' ? body.name : '')
      writeJson(res, 201, { ok: true, key })
      return
    }
    writeJson(res, 200, { ok: true, keys: keys.list() })
  })

  route(`${ROUTER_API_BASE}/keys/delete`, async (req, res) => {
    // exact route 无 path 参数：用 POST body {id}
    let body: { id?: string }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { id?: string }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const ok = typeof body.id === 'string' && keys.remove(body.id)
    writeJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'key not found' })
  })

  route(`${ROUTER_API_BASE}/keys/toggle`, async (req, res) => {
    let body: { id?: string; isActive?: boolean }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { id?: string; isActive?: boolean }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const ok = typeof body.id === 'string' && keys.setActive(body.id, !!body.isActive)
    writeJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'key not found' })
  })

  route(`${ROUTER_API_BASE}/settings`, async (req, res) => {
    if (req.method === 'PATCH') {
      let body: { requireApiKey?: boolean }
      try {
        body = JSON.parse(await readBody(req, 64 << 10)) as { requireApiKey?: boolean }
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (typeof body.requireApiKey === 'boolean') keys.requireApiKey = body.requireApiKey
    }
    writeJson(res, 200, { ok: true, requireApiKey: keys.requireApiKey })
  })

  // ---- 设置-模型：Router 提供方（固定卡片，插件注册，不可删）+ 模型目录（= 组合） ----

  // llm 缺失时（如测试环境）跳过，不影响 /v1 核心。
  if (ctx.llm !== undefined) {
    const LLM_NS = 'llm-dsh-router'
    try {
      const providerReg = ctx.llm.registerConfigurableProviders([
        {
          provider: 'router',
          displayName: 'Router',
          settingsNs: LLM_NS,
          settingsPath: [],
        },
      ])
      disposers.push(providerReg)
      disposers.push(ctx.llm.registerModelDiscovery(LLM_NS, async () => {
        const combos = await router.combos()
        return combos.map((c) => ({ id: c.name }))
      }))
      // adapter：模型目录自动带出组合；对话转发到本插件 /v1（组合路由在 /v1 内完成）。
      disposers.push(ctx.llm.registerAdapter(['router'], new RouterAdapter('http://localhost:3080/v1', {
        comboModels: async () => (await router.combos()).map((c) => ({ id: c.name })),
      })))
      log('llm provider (Router) + discovery + adapter registered ok')
    } catch (err) {
      ctx.logger.warn(`[dsh-router] llm registration failed: ${(err as Error).message}`)
    }
  } else {
    log('llm service NOT available — skip 设置-模型 registration')
  }

  // 调试：Router provider 状态（设置-模型排查用）
  route(`${ROUTER_API_BASE}/debug/llm`, async (_req, res) => {
    let directory: unknown = 'n/a'
    let registeredProviders: unknown = 'n/a'
    try {
      directory = ctx.llm !== undefined ? ctx.llm.listConfigurableProviders() : 'no llm'
    } catch (err) {
      directory = `error: ${(err as Error).message}`
    }
    try {
      registeredProviders = ctx.llm !== undefined ? ctx.llm.listProviders() : 'no llm'
    } catch (err) {
      registeredProviders = `error: ${(err as Error).message}`
    }
    writeJson(res, 200, {
      ok: true,
      llmAvailable: ctx.llm !== undefined,
      directory,
      registeredProviders,
    })
  })

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose()
      router.dispose()
    },
    'dsh-router: teardown',
  )
}
