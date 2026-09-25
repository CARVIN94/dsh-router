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
 *   GET  /router/api/stats                    usage overview (period=today|24h|7d|30d)
 *   GET  /router/api/stats/chart              usage bar chart buckets
 *   POST /router/api/stats/clear              reset all usage stats
 *   POST /router/api/suppliers/:id/login                  generate login URL
 *   POST /router/api/suppliers/:id/login/callback         {callbackUrl} → add account
 *   GET  /router/api/suppliers/:id/models                 models with enabled state
 *   PATCH /router/api/suppliers/:id/models/:mid           {enabled}
 *
 * `/v1/*` auth: gated by KeysStore.requireApiKey — when on, Bearer must be an
 * active library key. `/router/api/*` is same-origin, no auth.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { ROUTER_API_BASE, type RouterPeriod } from './shared.ts'
import { Router } from './router/index.ts'
import { RouterAdapter, type RouterAttachmentStore } from './llm/adapter.ts'
import { KeysStore } from './keys.ts'
import { loadSuppliers, supplierWins, wrapModule, type LoadedSupplier } from './suppliers/loader.ts'
import { supplierRoutes } from './suppliers/registry.ts'
import type { SupplierEnv, SupplierModule, SupplierRegistry } from './suppliers/contract.ts'
import { SupplierConfigStore } from './supplier-config.ts'
import { CredentialStore } from './credential-store.ts'
import { dataDirOf, profileDirOf } from './data-dir.ts'
import { detectHostVersion, isHost017Plus, supportsLastHitDock } from './host-version.ts'
import { ExtStore } from './ext/store.ts'
import type { ExtInfo, ExtStoreService, RouterExt, RouterExtService } from './ext/contract.ts'

/**
 * Plugin identity for cordis.yml rows — 必须与 package.json 的 name 一致。
 * loader 拿配置行里的 `name` 去 `import(name)`，写错就是从 npm 装完加载不到。
 */
export const name = 'dsh-router-core'

/** Services required before mounting: the webserver (routes) + llm (设置-模型). */
export const inject = ['webServer', 'llm']

/**
 * `Config` 导出：让 Router 卡片进 0.1.7 的设置镜像。
 *
 * **这处刻意保留能力检测，不用宿主版本号** —— 与另两处兼容点（installSection /
 * adapter 消息形态）不同。原因（已实测）：这是**模块顶层导出**，loader 一 import
 * 就求值；而 schemastery 是本插件的**普通依赖**（`^3.18.4`，见 package.json），
 * 解析到的是**插件自己 node_modules 里那一份**，跟宿主实际加载的版本无关
 * （实测：插件解析到 3.18.4，而 profile 里是 3.18.3、全局是 3.18.2）。既然这里
 * 拿不到宿主版本，就只剩「这份 Schema 实例到底有没有 `.volatile`」这个真问题 ——
 * 能力检测恰好就是**对**的判据。
 *
 * 定位说明（非兼容分叉）：`.volatile()` 是 schemastery 3.18.4 才有的原型方法；
 * 老版本上直写 `Schema.object({}).volatile()` 会 `.volatile` 为 undefined →
 * 抛 TypeError → **整个插件加载失败**（不只是卡片，是 dsh-router 完全挂掉）。
 *   - 有 volatile：走 volatile，空 object 不被 volatileForm 过滤 → 卡片进镜像；
 *   - 无 volatile：回落普通空 schema，不抛；此时宿主必是 0.1.5，本就靠
 *     installSection 出卡片（见下方按版本分流的注册），这个 Config 无副作用。
 */
const emptySchema = Schema.object({})
const hasVolatile = typeof (emptySchema as { volatile?: unknown }).volatile === 'function'

/**
 * 0.1.7 的设置镜像只认「插件导出的 Config + 配置树行 id」这条收录链，且空 object
 * 会被 volatileForm 过滤掉 —— 顶层 `.volatile()` 才能让 Router 卡片出现在设置-模型。
 * Router 的真配置在自己的 state.json（路由系统面板），这里故意不暴露任何字段。
 */
export const Config = hasVolatile ? emptySchema.volatile() : emptySchema

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

/**
 * 设置服务（`ctx.settings`，dsh-settings）的最小切面。0.1.5 用 `installSection`
 * 注册命名空间；0.1.7 已移除该方法、改由插件导出的 Config 驱动 —— 故声明为可选，
 * 调用处做能力检测（不是版本分支）。dsh-settings 是宿主注入的 peer service，不深绑类型。
 */
interface SettingsServiceFace {
  installSection?: (
    owner: CordisContext,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: { setSource: (current: () => unknown) => void; onChange: () => void },
  ) => void
}

/**
 * cordis Context 的最小切面。`installSection(owner)` 只会对 owner 调
 * `ctx.effect(...)` 并在卸载时读 `fiber.state`，所以这里只声明 `effect`。
 */
interface CordisContext {
  effect: (fn: () => () => void, label?: string) => unknown
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
    provide: (name: string, value: unknown) => unknown
    webServer: WebServer
    llm?: Llm
    logger: { info: (message: string) => void; warn: (message: string) => void }
    effect: (fn: () => () => void, label?: string) => void
    inject: (services: string[], callback: (sctx: unknown) => void) => void
    /** cordis-plugin-loader 挂在 fiber 上的配置树锚点（tests 等环境可能没有）。 */
    fiber?: { entry?: { options?: { id?: string } } }
    /** 配置树锚点 = profile 目录（宿主注入），用来把数据钉在 profile 里。 */
    baseUrl?: string
  }
  const log = (msg: string): void => ctx.logger.info(`[dsh-router] ${msg}`)

  // 数据目录必须是绝对路径：相对路径会让落盘位置跟着 process.cwd() 跑，
  // 从别的目录启动就静默换一套空配置（见 src/data-dir.ts）。
  const dataDir = dataDirOf(ctx.baseUrl)
  const stateFile = join(dataDir, 'state.json')
  log(`data dir: ${dataDir}`)
  // 宿主版本探测：三处 0.1.5/0.1.7 兼容分叉共用这一个判据（徽章 / 设置命名空间 /
  // adapter 的 tool-result 消息形态）。探测失败按老版本处理，不影响其它功能。
  const hostVersion = detectHostVersion(ctx.baseUrl)
  const host017Plus = isHost017Plus(ctx.baseUrl)
  const lastHitDock = supportsLastHitDock(ctx.baseUrl)
  log(`host version: ${hostVersion ?? '未知'} (>=0.1.7: ${host017Plus ? 'yes' : 'no'}, last-hit dock: ${lastHitDock ? 'on' : 'off'})`)
  const store = new SupplierConfigStore(stateFile)
  const credentials = new CredentialStore(join(dataDir, 'auths'))
  const router = new Router(stateFile, store, log)

  const keys = new KeysStore(stateFile)

  const disposers: Array<() => void> = []
  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  // ---- 供应商注册表：行（内置）+ 用户目录 js + 外部插件供应商 ----
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

  // 聚合表归核心所有：外部供应商插件（traework/codebuddy 等）只往里 append，不各自
  // provide（cordis 同一 service 只允许一个插件注册，重复 provide 会抛错）。核心先提供
  // 空表，任何独立安装的供应商插件都能经 ctx.inject(['router.suppliers']) 拿到同一个
  // live 表把自己挂进来——不再依赖某个「宿主」插件提供它（此前只有 traework 会 provide，
  // 单装 dsh-router-codebuddy 时表永不出现，codebuddy 就一直不生效）。
  ctx.provide('router.suppliers', {})

  // ---- 扩展 (Ext)：router.ext 注册表 + router.extStore 存储 ----
  // 核心只做**管理面**：发现（注册表）、展示（面板/API）、代存开关与插件数据。
  // 拦截 tools/execute / 裁决 enabled+ready / 短路执行全部归扩展插件自己 —— 见
  // ext/contract.ts 文件头。同 router.suppliers 模式：核心持有空表，扩展插件经
  // ctx.inject 追加进同一个 live 对象。
  const exts: Record<string, unknown> = {}
  ctx.provide('router.ext', exts)
  // 开关 + 插件数据归核心持久化(<dataDir>/ext.json);插件经此 service 读写,不自己 file IO。
  const extStore = new ExtStore(stateFile)
  ctx.provide('router.extStore', extStore as unknown as ExtStoreService)

  // 内置 + 用户 + 外部插件供应商（异步加载，完成后注册路由 + 加入路由器）
  const registerLoaded = (loaded: LoadedSupplier): void => {
    // 同 id 已有供应商：只有「级别更高」的那个能顶掉它（用户目录 js > 内置行 >
    // 外部插件）。级别不高不低就直接丢，别把先到的那份卸了又装回来。
    const existing = loadedSuppliers.find((l) => l.supplier.id === loaded.supplier.id)
    if (existing !== undefined) {
      if (!supplierWins(loaded.source, existing.source)) {
        log(`supplier ${loaded.supplier.id} (${loaded.source}) skipped: ${existing.source} already registered`)
        return
      }
      log(`supplier ${loaded.supplier.id}: ${existing.source} replaced by ${loaded.source}`)
      unregisterSupplier(loaded.supplier.id)
    }
    loadedSuppliers.push(loaded)
    router.add(loaded.supplier)
    registerSupplierRoutes(loaded)
  }
  /** 当前由 router.suppliers service 加载的供应商 id（外部插件卸载时全部注销）。 */
  let externalSupplierIds: string[] = []
  const loadExternal = (suppliers: SupplierRegistry): void => {
    for (const [sid, factory] of Object.entries(suppliers)) {
      if (externalSupplierIds.includes(sid)) continue // 已加载（internal/service + inject 可能重复触发）
      try {
        const module = factory({ dataDir, log, store, credentials })
        // 工厂上的 source 标签决定 `/health` 怎么报它：内置行标 'builtin'，独立
        // 安装的供应商插件不标（= external）。面板按这个值分「内置 / 插件」两组，
        // 标错就把随核心分发的供应商混进插件组了。
        const kind = factory.source === 'builtin' ? 'builtin' : 'external'
        const loaded = wrapModule(module, { dataDir, log, store, credentials }, `service router.suppliers.${sid}`, kind)
        registerLoaded(loaded)
        externalSupplierIds.push(loaded.supplier.id)
        log(`${kind} supplier loaded: ${sid}`)
      } catch (err) {
        ctx.logger.warn(`[dsh-router] supplier ${sid} load failed: ${(err as Error).message}`)
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
      // 用户供应商目录也在 profile 里：跟着 baseUrl 走，别硬编码 `web`。
      const userDir = join(profileDirOf(ctx.baseUrl), 'suppliers')
      const { suppliers, errors } = await loadSuppliers({
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
    let peek: { stream?: boolean; model?: string; reasoning_effort?: unknown }
    try {
      peek = JSON.parse(body) as { stream?: boolean; model?: string; reasoning_effort?: unknown }
    } catch {
      writeJson(res, 400, { error: { message: 'invalid JSON body', type: 'api_error', code: 'invalid_request' } })
      return
    }
    const lv = typeof peek.reasoning_effort === 'string' && peek.reasoning_effort !== ''
      ? peek.reasoning_effort
      : 'auto'
    // 宿主会话身份（adapter 从 GenerateOptions.sessionId 转来的内部头）；外部客户端没有。
    const sessionRaw = req.headers['x-dsh-router-session']
    const session = typeof sessionRaw === 'string' && sessionRaw !== '' ? sessionRaw : undefined
    await router.chatCompletions(
      {
        rawBody: body,
        stream: !!peek.stream,
        model: typeof peek.model === 'string' ? peek.model : '',
        lv,
        ...(session === undefined ? {} : { session }),
      },
      res,
    )
  }))

  // ---- /router/api/* (panel, same-origin) ----

  route(`${ROUTER_API_BASE}/health`, (_req, res) => {
    const { suppliers } = router.status()
    writeJson(res, 200, {
      ok: true,
      // 宿主版本 + 徽章支持位：客户端据此决定是否挂「最近命中」控件
      // （composer.dock 在 0.1.5 渲染位置不对，只有 >= 0.1.7 才挂）。
      hostVersion: hostVersion ?? '',
      lastHitDock: lastHitDock,
      suppliers: suppliers.map((s) => {
        const loaded = loadedSuppliers.find((l) => l.supplier.id === s.id)
        return {
          id: s.id,
          name: s.name,
          icon: loaded?.supplier.icon,
          apiKeyHint: loaded?.supplier.apiKeyHint,
          capabilities: loaded ? [...loaded.capabilities] : [],
          source: loaded?.source ?? 'external',
          // 开关状态：关掉的供应商**仍在列表里**（关掉后要能再开），只是不参与路由。
          enabled: s.enabled,
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

  // 连接池连接改名：只改面板显示名（存核心 store 的 accountNames，uid 不变）。
  route(`${ROUTER_API_BASE}/status/rename`, async (req, res) => {
    let body: { supplier?: string; uid?: string; name?: string }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { supplier?: string; uid?: string; name?: string }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    if (typeof body.supplier !== 'string' || body.supplier === '' || typeof body.uid !== 'string' || body.uid === '') {
      writeJson(res, 400, { ok: false, error: 'supplier and uid are required' })
      return
    }
    store.setAccountName(body.supplier, body.uid, typeof body.name === 'string' ? body.name : '')
    writeJson(res, 200, { ok: true })
  })

  route(`${ROUTER_API_BASE}/last-hit`, (req, res) => {
    // 最近一次被服务的请求：给输入框旁的小指示器用。
    // `?session=` 给定时只在该会话内找（当前会话视角）；不给则退回全局最近。
    // 附上连接显示别名与积分 —— 前端只读这一个端点，不打 status（重）。
    const session = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? undefined
    const last = router.usage.lastHit(session)
    if (last === undefined) {
      writeJson(res, 200, { ok: true, hit: null })
      return
    }
    const { suppliers } = router.status()
    const owner = suppliers.find((s) => s.id === last.supplier)
    const acct = owner?.accounts.find((a) => a.uid === last.uid)
    // 连接名：**优先直接查 accountNames**（面板里配的显示别名），不依赖
    // status 列表里有没有这个号 —— 号未上报/未加载时 status 里就没有它，
    // 只靠 acct 会回落成 uid（显示成 cb-12 而不是 k8661）。
    const named = last.uid === undefined || last.uid === '' ? undefined : store.getAccountName(last.supplier, last.uid)
    writeJson(res, 200, {
      ok: true,
      hit: {
        supplier: last.supplier,
        model: last.model,
        requested: last.requested,
        uid: last.uid,
        account: named ?? acct?.nickname ?? (last.uid === undefined || last.uid === '' ? undefined : last.uid),
        credits: acct?.credits,
        ok: last.ok,
        ts: last.ts,
      },
    })
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
    let body: { name?: string; models?: string[] }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { name?: string; models?: string[] }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const result = router.createCombo(body.name ?? '', body.models ?? [])
    writeJson(res, result.ok ? 200 : 400, result)
  })

  route(`${ROUTER_API_BASE}/combos/update`, async (req, res) => {
    let body: { id?: string; name?: string; models?: string[] }
    try {
      body = JSON.parse(await readBody(req, 64 << 10)) as { id?: string; name?: string; models?: string[] }
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const result = router.updateCombo(body.id ?? '', body.name ?? '', body.models ?? [])
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

  // ---- 扩展 (Ext)：扩展器列表 + 开关 ----
  route(`${ROUTER_API_BASE}/ext`, async (req, res) => {
    if (req.method === 'PATCH') {
      let body: { id?: unknown; enabled?: unknown }
      try {
        body = JSON.parse(await readBody(req, 64 << 10)) as { id?: unknown; enabled?: unknown }
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const ext = typeof body.id === 'string' ? exts[body.id] as RouterExtService[string] : undefined
      if (!ext) {
        writeJson(res, 404, { ok: false, error: 'extension not found' })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        writeJson(res, 400, { ok: false, error: 'enabled must be a boolean' })
        return
      }
      const wantOn = body.enabled
      // 开启自检：不可用(ready !== true)的扩展**不能开启成功**——即使绕过面板
      // 直连 API 也会被拒。由扩展器报告就绪状态,核心据此裁决。
      if (wantOn && typeof ext.getState === 'function') {
        const st = ext.getState()
        if (st?.ready !== true) {
          writeJson(res, 409, { ok: false, error: st?.detail ?? 'extension not ready' })
          return
        }
      }
      // 开关归核心持久化。
      extStore.setEnabled(ext.id, body.enabled)
    }
    const list: ExtInfo[] = Object.values(exts as RouterExtService)
      .map((raw): ExtInfo | undefined => {
        const e = raw as RouterExt
        if (!e || typeof e.id !== 'string' || e.id === '') return undefined
        const st = typeof e.getState === 'function' ? e.getState() : { ready: false }
        return {
          id: e.id,
          name: e.name ?? e.id,
          ...(e.description !== undefined ? { description: e.description } : {}),
          ...(e.icon !== undefined ? { icon: e.icon } : {}),
          enabled: extStore.isEnabled(e.id),
          ready: st?.ready === true,
          ...(st?.detail !== undefined ? { detail: st.detail } : {}),
        }
      })
      .filter((e): e is ExtInfo => e !== undefined)
    writeJson(res, 200, { ok: true, enhancers: list })
  })

  // ---- 概览看板：用量统计 ----

  /** 解析并校验周期参数（不接受任意字符串）。 */
  const periodOf = (raw: string | null): RouterPeriod => {
    return raw === '24h' || raw === '7d' || raw === '30d' ? raw : 'today'
  }

  route(`${ROUTER_API_BASE}/stats`, (req, res) => {
    const period = periodOf(new URL(req.url ?? '/', 'http://localhost').searchParams.get('period'))
    const s = router.usage.stats(period)
    writeJson(res, 200, {
      ok: true,
      period,
      requests: s.requests,
      okCount: s.ok,
      failed: s.failed,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      cachedTokens: s.cachedTokens,
      avgDurationMs: s.avgDurationMs,
      avgTtfbMs: s.avgTtfbMs,
      estimatedInputs: s.estimatedInputs,
      estimatedOutputs: s.estimatedOutputs,
      lifetime: s.lifetime,
      bySupplier: s.bySupplier,
      byModel: s.byModel,
      byRequested: s.byRequested,
      // 「最近请求」的「连接」列要显示连接名（uid → 显示别名）。后端一次解析，
      // 前端不必再拉 /status。无 uid（失败/未服务）→ 返回空串，前端显示「—」。
      recent: router.usage.recentList(20).map((r) => ({
        ...r,
        connection: r.uid === undefined || r.uid === ''
          ? ''
          : store.getAccountName(r.supplier, r.uid) ?? r.uid,
      })),
    })
  })

  route(`${ROUTER_API_BASE}/stats/chart`, (req, res) => {
    const period = periodOf(new URL(req.url ?? '/', 'http://localhost').searchParams.get('period'))
    writeJson(res, 200, { ok: true, chart: router.usage.chart(period) })
  })

  route(`${ROUTER_API_BASE}/stats/clear`, async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    router.usage.clear()
    writeJson(res, 200, { ok: true })
  })

  // ---- 设置-模型：Router 提供方（固定卡片，插件注册，不可删）+ 模型目录（= 组合） ----

  // settings ns = 配置树行 id（cordis.patch.yml insert 的 id）—— 0.1.7 设置镜像按
  // entry.options.id 收录；loader 未挂 entry 时回落到同一默认值，两版一个 ns。
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'dsh-router'

  // llm 缺失时（如测试环境）跳过，不影响 /v1 核心。
  if (ctx.llm !== undefined) {
    try {
      const providerReg = ctx.llm.registerConfigurableProviders([
        {
          provider: 'router',
          displayName: 'Router',
          settingsNs,
          settingsPath: [],
        },
      ])
      disposers.push(providerReg)
      disposers.push(ctx.llm.registerModelDiscovery(settingsNs, async () => {
        const combos = await router.combos()
        return combos.map((c) => ({ id: c.name }))
      }))
      // Router 的配置（组合/密钥/签到）存在 core 自己的 state.json，走插件自己的
      // 「路由系统」面板；设置-模型 这边必须让 settingsNs 在设置镜像里能解析出来
      // （见 dsh-client-ui-settings-models 的 configurable 过滤），否则卡片不出现。
      // 按宿主版本分流（不再靠 installSection 能力检测）：
      //   0.1.7+：镜像行来自顶部导出的 volatile Config（ns = 行 id），无需注册；
      //   0.1.5 ：镜像行来自 settings.installSection。
      // 空 schema = 卡片是入口/占位（该布局下不可提交），真正的配置在路由系统面板。
      const routerSettingsSchema = Schema.object({})
      if (isHost017Plus(ctx.baseUrl)) {
        log(`settings section driven by exported Config (${settingsNs})`)
      } else {
        ctx.inject(['settings'], (sctx: unknown) => {
          const settings = (sctx as { settings?: SettingsServiceFace }).settings
          if (settings === undefined) {
            log('settings service absent — skip Router settings-section registration')
            return
          }
          if (settings.installSection === undefined) {
            // 版本说该走 installSection 但它不在（异常宿主）：只记日志，不抛。
            log(`settings.installSection absent despite 0.1.5 host (${settingsNs})`)
            return
          }
          settings.installSection(rawContext as CordisContext, settingsNs, routerSettingsSchema, {}, {
            setSource: () => {},
            onChange: () => {},
          })
          log(`Router settings section registered (${settingsNs})`)
        })
      }
      // adapter：模型目录自动带出组合；对话转发到本插件 /v1（组合路由在 /v1 内完成）。
      // 带上组合的上下文窗口：没有它 dsh 的自动压缩算不出阈值、会静默关闭。
      // 图片序列化需要读附件字节：把 ctx.attachments 传给 adapter（dsh-attachment
      // 是宿主注入的 service，插件不直接 import 它，只依赖 duck-typed 切面）。
      disposers.push(ctx.llm.registerAdapter(['router'], new RouterAdapter('http://localhost:3080/v1', {
        comboModels: async () => (await router.combos()).map((c) => {
          const w = router.comboContextWindow(c)
          return { id: c.name, ...(w !== undefined ? { contextWindow: w } : {}) }
        }),
      }, () => ctx.get('attachments') as RouterAttachmentStore | undefined)))
      log('llm provider (Router) + discovery + adapter registered ok')
      // 预热模型缓存：`comboContextWindow` 只读缓存、不打上游，缓存空着就
      // 报不出窗口。这里后台填一次，让第一次 resolveModel 就有值。
      // 失败无所谓（下次 modelsOf 还会拉），不能冒出来。
      void (async () => {
        for (const c of await router.combos()) {
          for (const ref of c.models) {
            const at = ref.indexOf(',')
            if (at < 0) continue
            try { await router.modelsOf(ref.slice(0, at)) } catch { /* 单家失败不连坐 */ }
          }
        }
      })().catch(() => {})
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
    // 设置命名空间是否注册成功 —— 卡片不出现的**唯一**嫌疑点：provider 在目录里
    // （上面的 directory）却没注册 section 时，设置-模型 的 configurable 过滤会
    // 把该行整条丢掉，界面上什么都不显示、也没有任何报错。
    let settingsNamespaces: unknown = 'n/a'
    try {
      const settings = ctx.get('settings') as { describe?: (opts?: unknown) => Array<{ ns: string }> } | undefined
      settingsNamespaces = settings?.describe === undefined
        ? 'no settings service'
        : settings.describe({ redactSecrets: true }).map((d) => d.ns)
    } catch (err) {
      settingsNamespaces = `error: ${(err as Error).message}`
    }
    writeJson(res, 200, {
      ok: true,
      llmAvailable: ctx.llm !== undefined,
      directory,
      registeredProviders,
      settingsNamespaces,
      routerNamespaceRegistered: Array.isArray(settingsNamespaces) && settingsNamespaces.includes(settingsNs),
    })
  })

  ctx.effect(
    () => () => {
      // 注册表里的扩展器（插件自己 inject 的清理会摘键；这里兜底 dispose 仍在表里的）。
      for (const raw of Object.values(exts as RouterExtService)) {
        try {
          ;(raw as RouterExt)?.dispose?.()
        } catch {
          // 卸载清理失败不影响其他清理
        }
      }
      for (const dispose of disposers.splice(0)) dispose()
      router.dispose() // 内部会 flush 用量统计（防抖中的计数不能丢）
    },
    'dsh-router: teardown',
  )
}
