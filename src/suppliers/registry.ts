/**
 * 供应商注册表 —— 持有加载的供应商 + 按能力暴露的通用端点。
 *
 * 通用能力（dsh-router 核心，所有供应商自动可用，js 无需实现）：
 *   GET    /suppliers/:id/models                  models + alias（listModels 合并启用状态）
 *   POST   /suppliers/:id/models/toggle           {id, enabled}
 *   POST   /suppliers/:id/models/add              {id}
 *   POST   /suppliers/:id/models/remove           {id}
 *   POST   /suppliers/:id/models/bulk             {enabled}
 *   POST   /suppliers/:id/alias                   {alias}
 *   GET    /suppliers/:id/pool/order              + POST {uids}
 *   GET    /suppliers/:id/pool/strategy           + POST {strategy}
 *
 * 差异化能力（供应商 js 实现，按存在性注册；未实现返回 404）：
 *   POST   /suppliers/:id/models/fetch            拉取上游模型
 *   POST   /suppliers/:id/models/test             {id}
 *   POST   /suppliers/:id/login                   生成登录链接
 *   POST   /suppliers/:id/login/callback          {callbackUrl}
 *   POST   /suppliers/:id/links/remove            {uid}
 *   POST   /suppliers/:id/links/refresh           刷新链接池（积分，核心调 status() 等落地）
 *   POST   /suppliers/:id/checkin                 签到所有链接（核心遍历 + 汇总）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Router } from '../router/index.ts'
import type { ModelWithEnabled, SupplierStatus } from '../router/types.ts'
import type { SupplierConfigStore } from '../supplier-config.ts'
import type { LoadedSupplier } from './loader.ts'

/** webServer 路由形状（与 index.ts 的 WebServerRoute 一致）。 */
export interface WebServerRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage, limit = 64 << 10): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  return await new Promise((resolve, reject) => {
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

function cap(set: Set<string>, key: string): boolean {
  return set.has(key)
}

/** 账号状态指纹（积分 + 健康），用于判断刷新是否落地。 */
function fingerprint(accounts: SupplierStatus['accounts']): string {
  return accounts.map((a) => `${a.uid}:${a.credits}:${a.cooling}:${a.disabled}`).join('|')
}

/**
 * 反复调插件已有的 status()，直到快照稳定再返回（是否有变化 = changed）。
 * 插件的积分刷新是 fire-and-forget（status() 内部异步拉），核心拿不到句柄，
 * 只能按指纹变化等它落地。天花板：缓存未过期时插件不会真拉上游，此时按钮
 * 退化为「重读一次状态」（冷却/禁用这类健康状态仍是 status() 实时算的）。
 * 升级路径：插件暴露可 await 的刷新能力，这里就不用轮询了。
 */
async function settleStatus(s: LoadedSupplier['supplier'], timeoutMs = 3000): Promise<boolean> {
  const first = fingerprint(s.status().accounts)
  const deadline = Date.now() + timeoutMs
  let last = first
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const now = fingerprint(s.status().accounts)
    stable = now === last ? stable + 1 : 0
    last = now
    if (stable >= 2) break // 连续两次没变 → 认为刷新已落地
  }
  return last !== first
}

/** 模型列表统一缓存（dsh-router 核心管；插件只管拉取，不缓存）。 */
const modelsCache = new Map<string, { models: ModelWithEnabled[]; fetchedAt: number }>()
const MODELS_TTL_MS = 60 * 1000

/** 拉取并缓存某供应商模型（force 时强制刷新）。custom 模型并入显示。 */
async function cachedModels(s: LoadedSupplier['supplier'], cfg: ReturnType<SupplierConfigStore['get']>, force = false): Promise<ModelWithEnabled[]> {
  const hit = modelsCache.get(s.id)
  if (!force && hit && Date.now() - hit.fetchedAt < MODELS_TTL_MS) return hit.models
  const list = await Promise.resolve(s.listModels())
  const custom = new Set(cfg.custom)
  const disabled = new Set(cfg.disabled)
  const models: ModelWithEnabled[] = list.map((mm) => ({
    ...mm,
    enabled: !disabled.has(mm.id),
    custom: custom.has(mm.id) ? true : undefined,
  }))
  // 自定义模型（listModels 之外的）并入显示
  const seen = new Set(models.map((mm) => mm.id))
  for (const id of custom) {
    if (!seen.has(id)) {
      seen.add(id)
      models.push({ id, enabled: !disabled.has(id), custom: true })
    }
  }
  modelsCache.set(s.id, { models, fetchedAt: Date.now() })
  return models
}

function mod(s: LoadedSupplier): Record<string, unknown> {
  return (s.supplier as unknown as { __module?: Record<string, unknown> }).__module ?? {}
}

/** 为一个供应商生成端点（通用 + 差异化，返回 route 列表）。 */
export function supplierRoutes(base: string, loaded: LoadedSupplier, store: SupplierConfigStore, router: Router): WebServerRoute[] {
  const s = loaded.supplier
  const m = mod(loaded)
  const c = loaded.capabilities
  const p = `${base}/suppliers/${s.id}`
  const routes: WebServerRoute[] = []

  // ---- 通用: models（listModels 差异化 + 启用状态通用；核心统一缓存） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models`,
    handler: async (_req, res) => {
      const models = await cachedModels(s, store.get(s.id))
      writeJson(res, 200, { ok: true, alias: s.getAlias(), models })
    },
  })

  // ---- 通用: alias ----
  routes.push({
    kind: 'exact',
    path: `${p}/alias`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { alias?: string }
      const alias = body.alias ?? ''
      const clean = alias.trim()
      if (clean === '' || !/^[A-Za-z0-9_-]+$/.test(clean)) {
        writeJson(res, 400, { ok: false, error: '前缀只能包含字母、数字、- 和 _' })
        return
      }
      store.setAlias(s.id, clean)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: models/toggle ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/toggle`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { id?: string; enabled?: boolean }
      const cfg = store.get(s.id)
      const models = await cachedModels(s, cfg)
      if (!body.id || !models.some((mm) => mm.id === body.id)) {
        writeJson(res, 400, { ok: false, error: '模型不存在' })
        return
      }
      store.setModelEnabled(s.id, body.id, !!body.enabled)
      modelsCache.delete(s.id) // 启用状态变化后失效缓存
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: models/add（自定义模型） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/add`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { id?: string }
      const id = (body.id ?? '').trim()
      if (id === '') {
        writeJson(res, 400, { ok: false, error: '模型 id 不能为空' })
        return
      }
      const models = await cachedModels(s, store.get(s.id))
      if (models.some((mm) => mm.id === id)) {
        writeJson(res, 400, { ok: false, error: `模型 ${id} 已存在` })
        return
      }
      store.addCustomModel(s.id, id)
      modelsCache.delete(s.id)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: models/remove（自定义模型） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/remove`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { id?: string }
      const cfg = store.get(s.id)
      if (!body.id || !cfg.custom.includes(body.id)) {
        writeJson(res, 400, { ok: false, error: `模型 ${body.id} 不是自定义模型` })
        return
      }
      store.removeCustomModel(s.id, body.id)
      modelsCache.delete(s.id)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: models/bulk ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/bulk`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { enabled?: boolean }
      const models = await cachedModels(s, store.get(s.id))
      store.setAllModelsEnabled(s.id, !!body.enabled, models.map((mm) => mm.id))
      modelsCache.delete(s.id)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: pool/order + pool/strategy ----
  routes.push({
    kind: 'exact',
    path: `${p}/pool/order`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, order: store.get(s.id).poolOrder })
        return
      }
      const body = JSON.parse(await readBody(req)) as { uids?: string[] }
      if (!Array.isArray(body.uids) || body.uids.some((u) => typeof u !== 'string')) {
        writeJson(res, 400, { ok: false, error: '顺序必须是 uid 数组' })
        return
      }
      store.setPoolOrder(s.id, body.uids)
      writeJson(res, 200, { ok: true })
    },
  })

  routes.push({
    kind: 'exact',
    path: `${p}/pool/strategy`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, strategy: store.get(s.id).poolStrategy })
        return
      }
      const body = JSON.parse(await readBody(req)) as { strategy?: string }
      if (body.strategy !== 'fallback' && body.strategy !== 'round-robin') {
        writeJson(res, 400, { ok: false, error: '策略无效' })
        return
      }
      store.setPoolStrategy(s.id, body.strategy)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用 UI: 获取模型（= 强制刷新 + 核心缓存更新） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/fetch`,
    handler: async (_req, res) => {
      const models = await cachedModels(s, store.get(s.id), true)
      writeJson(res, 200, { ok: true, models })
    },
  })

  // ---- 通用: 测试模型（核心统一走 chatCompletions 路径，账号池回退/冷却自动生效） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/test`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { id?: string }
      const result = await router.testModel(s.id, body.id ?? '')
      writeJson(res, result.ok ? 200 : 400, result)
    },
  })

  // ---- 通用 UI: 添加链接（差异化实现 generateLoginUrl/completeLogin） ----
  routes.push({
    kind: 'exact',
    path: `${p}/login`,
    handler: async (_req, res) => {
      if (!cap(c, 'generateLoginUrl')) {
        writeJson(res, 400, { ok: false, error: '该供应商不支持添加链接' })
        return
      }
      const r = await (m.generateLoginUrl as () => string | { ok: boolean; error?: string; loginUrl?: string } | Promise<string | { ok: boolean; error?: string; loginUrl?: string }>).call(loaded.supplier)
      if (typeof r === 'string') writeJson(res, 200, { ok: true, loginUrl: r })
      else writeJson(res, r.ok === false ? 400 : 200, r)
    },
  })
  routes.push({
    kind: 'exact',
    path: `${p}/login/callback`,
    handler: async (req, res) => {
      if (!cap(c, 'completeLogin')) {
        writeJson(res, 400, { ok: false, error: '该供应商不支持添加链接' })
        return
      }
      const body = JSON.parse(await readBody(req)) as { callbackUrl?: string }
      try {
        const acct = await (m.completeLogin as (url: string) => Promise<{ uid: string; nickname: string }>).call(loaded.supplier, body.callbackUrl ?? '')
        writeJson(res, 200, { ok: true, account: acct })
      } catch (err) {
        writeJson(res, 400, { ok: false, error: (err as Error).message })
      }
    },
  })

  // ---- 通用 UI: 添加 API key 账号（差异化实现 addApiKey，弹窗填名字+key） ----
  routes.push({
    kind: 'exact',
    path: `${p}/links/add`,
    handler: async (req, res) => {
      if (!cap(c, 'addApiKey')) {
        writeJson(res, 400, { ok: false, error: '该供应商不支持添加 API key' })
        return
      }
      const body = JSON.parse(await readBody(req)) as { name?: string; apiKey?: string }
      try {
        const r = await (m.addApiKey as (input: { name: string; apiKey: string }) => Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }>).call(loaded.supplier, {
          name: (body.name ?? '').trim(),
          apiKey: (body.apiKey ?? '').trim(),
        })
        writeJson(res, r.ok === false ? 400 : 200, r)
      } catch (err) {
        writeJson(res, 400, { ok: false, error: (err as Error).message })
      }
    },
  })

  // ---- 通用 UI: 删除链接（数据删除，核心统一；凭证清理由供应商内部 removeLink） ----
  routes.push({
    kind: 'exact',
    path: `${p}/links/remove`,
    handler: async (req, res) => {
      if (typeof s.removeLink !== 'function') {
        writeJson(res, 400, { ok: false, error: '该供应商不支持删除链接' })
        return
      }
      const body = JSON.parse(await readBody(req)) as { uid?: string }
      const ok = await s.removeLink(body.uid ?? '')
      writeJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'link not found' })
    },
  })

  // ---- 通用: 刷新链接池（积分 + 健康） ----
  // 刷新是核心的活，但只调插件已有的 status()——插件在 status() 里自带积分
  // 异步刷新（缓存过期才真拉上游），冷却/禁用（健康）也是 status() 实时算的。
  routes.push({
    kind: 'exact',
    path: `${p}/links/refresh`,
    handler: async (_req, res) => {
      try {
        const changed = await settleStatus(s)
        writeJson(res, 200, { ok: true, changed, accounts: s.status().accounts })
      } catch (err) {
        writeJson(res, 500, { ok: false, error: (err as Error).message })
      }
    },
  })

  if (cap(c, 'checkinNow')) {
    routes.push({
      kind: 'exact',
      path: `${p}/checkin`,
      handler: async (_req, res) => {
        // 签到 = 所有链接逐个签一次：checkinNow 是单账号能力，
        // 遍历与汇总是核心的活（插件不负责连接池顺序/范围）。
        // 禁用与否由插件自己判定（如 traework 返回 status:'disabled'），核心不替它筛。
        const checkinOne = m.checkinNow as
          ((uid: string) => Promise<{ ok: boolean; status: string; message?: string }>) | undefined
        if (!checkinOne) {
          writeJson(res, 400, { ok: false, error: '该供应商不支持签到' })
          return
        }
        type CheckinResult = { uid: string; ok: boolean; status: string; message?: string }
        const uids = s.status().accounts.map((a) => a.uid)
        const results: CheckinResult[] = []
        // 单个链接抛错不能带垮整批：记成 error 继续下一个
        for (const uid of uids) {
          try {
            results.push({ uid, ...(await checkinOne.call(loaded.supplier, uid)) })
          } catch (err) {
            results.push({ uid, ok: false, status: 'error', message: (err as Error).message })
          }
        }
        const succeeded = results.filter((r) => r.status === 'ok').length
        const already = results.filter((r) => r.status === 'already').length
        const payload = { ok: succeeded + already > 0, total: uids.length, succeeded, already, results }
        writeJson(res, payload.ok ? 200 : 400, payload)
      },
    })
  }

  return routes
}
