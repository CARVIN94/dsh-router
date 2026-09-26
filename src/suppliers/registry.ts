/**
 * 供应商注册表 —— 持有加载的供应商 + 按能力暴露的通用端点。
 *
 * 通用能力（dsh-router 核心，所有供应商自动可用，js 无需实现）：
 *   GET    /suppliers/:id/models                  models + alias（listModels 合并启用状态）
 *   POST   /suppliers/:id/probe                  契约体检：逐成员报「实现/可用/不执行」
 *   PATCH  /suppliers/:id/enabled                 {enabled} —— 供应商开关（关掉不参与路由）
 *   POST   /suppliers/:id/models/toggle           {id, enabled}
 *   POST   /suppliers/:id/models/add              {id}
 *   POST   /suppliers/:id/models/remove           {id}
 *   POST   /suppliers/:id/models/bulk             {enabled}
 *   POST   /suppliers/:id/alias                   {alias}
 *   GET    /suppliers/:id/pool/order              + POST {uids}
 *
 * 差异化能力（供应商 js 实现，按存在性注册；未实现返回 404）：
 *   POST   /suppliers/:id/models/fetch            拉取上游模型
 *   POST   /suppliers/:id/models/test             {id, uid?}（uid = 只测这个连接）
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
import { probeSupplier } from './probe.ts'

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
  return accounts.map((a) => `${a.uid}:${a.credits}:${a.cooling}`).join('|')
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
      const models = await router.modelsOf(s.id)
      writeJson(res, 200, { ok: true, alias: s.getAlias(), models })
    },
  })

  // ---- 通用: 供应商开关 ----
  // 与扩展开关同构（用户对核心面板的操作，归核心持久化）。关掉 = 核心不把它接进
  // 路由：`Router` 的活跃集合里没有它，请求/模型列表/组合都看不到，而它自己仍留在
  // `/health` 与面板里 —— 否则关掉之后就找不回来，开关也失去了对象。
  routes.push({
    kind: 'exact',
    path: `${p}/enabled`,
    handler: async (req, res) => {
      let body: { enabled?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as { enabled?: unknown }
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        writeJson(res, 400, { ok: false, error: 'enabled must be a boolean' })
        return
      }
      store.setEnabled(s.id, body.enabled)
      router.invalidateModels(s.id)
      writeJson(res, 200, { ok: true, id: s.id, enabled: router.isEnabled(s.id) })
    },
  })

  // ---- 契约体检（只跑只读成员；有副作用的只报存在性）----
  routes.push({
    kind: 'exact',
    path: `${p}/probe`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'probe requires POST' })
        return
      }
      try {
        // body 可空；只用来选模型/连接（不选就用第一个可用的）
        let pick: { model?: string; uid?: string } = {}
        const raw = (await readBody(req)).trim()
        if (raw !== '') {
          const body = JSON.parse(raw) as { model?: unknown; uid?: unknown }
          pick = {
            ...(typeof body.model === 'string' ? { model: body.model } : {}),
            ...(typeof body.uid === 'string' ? { uid: body.uid } : {}),
          }
        }
        // 模型启用状态走 router.modelsOf（核心缓存，不额外打上游）
        const models = await router.modelsOf(s.id).catch(() => undefined)
        const report = await probeSupplier(loaded, {
          models,
          // **实跑「全部禁用 → 看列表 → 全部启用」，验完还原。**
          //
          // 这是体检里唯一能抓出「插件在 listModels 里过滤已禁用模型」越权的路径：
          // 违规插件把已禁用的藏起来，于是全部禁用之后核心一个模型都看不到，
          // 用户点「全部启用」也就再也点不回来（没有 id 可传）。
          // 还原写在 finally —— 体检不该在用户配置上留痕，哪怕中间抛了。
          runBulkToggleRoundTrip: async () => {
            const original = [...store.get(s.id).disabled]
            const before = await router.modelsOf(s.id)
            const ids = before.map((mm) => mm.id)
            if (ids.length === 0) return { ok: true, detail: '该供应商没有模型，跳过' }
            try {
              store.setAllModelsEnabled(s.id, false, ids)
              router.invalidateModels(s.id)
              const after = await router.modelsOf(s.id, true)
              const hidden = after.filter((mm) => !mm.enabled).length
              const missing = ids.length - after.length
              if (hidden !== ids.length || missing !== 0) {
                return {
                  ok: false,
                  detail: `全部禁用之后只剩 ${after.length}/${ids.length} 个模型（其中 ${hidden} 个标记为停用）—— 插件把已禁用的模型从 listModels 里藏起来了；启用状态归核心合并，插件不该自己筛`,
                }
              }
              return { ok: true, detail: `全部禁用后 ${after.length} 个模型都在（均标记停用），再全部启用可恢复` }
            } finally {
              store.setAllModelsEnabled(s.id, true, ids)
              for (const id of original) store.setAllModelsEnabled(s.id, false, [id])
              router.invalidateModels(s.id)
              await router.modelsOf(s.id, true)
            }
          },
          // chatOnce 真跑一次：账号遍历 / 冷却 / 首字节预算都走真实路径
          runChatOnce: async (model) => {
            const r = await router.testModel(s.id, model, pick.uid)
            return { ok: r.ok, detail: r.ok ? '通了' : (r.error ?? '上游没给原因') }
          },
        })
        writeJson(res, 200, { ok: true, report })
      } catch (err) {
        writeJson(res, 500, { ok: false, error: (err as Error).message })
      }
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
      // 空 = 用供应商 id（默认值），合法；非空则校验字符集
      if (clean !== '' && !/^[A-Za-z0-9_-]+$/.test(clean)) {
        writeJson(res, 400, { ok: false, error: '前缀只能包含字母、数字、- 和 _' })
        return
      }
      const r = store.setAlias(s.id, clean)
      if (!r.ok) {
        writeJson(res, 400, { ok: false, error: `前缀已被供应商 ${JSON.stringify(r.conflictWith ?? '?')} 占用` })
        return
      }
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
      const models = await router.modelsOf(s.id)
      if (!body.id || !models.some((mm) => mm.id === body.id)) {
        writeJson(res, 400, { ok: false, error: '模型不存在' })
        return
      }
      store.setModelEnabled(s.id, body.id, !!body.enabled)
      router.invalidateModels(s.id)
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
      const models = await router.modelsOf(s.id)
      if (models.some((mm) => mm.id === id)) {
        writeJson(res, 400, { ok: false, error: `模型 ${id} 已存在` })
        return
      }
      store.addCustomModel(s.id, id)
      router.invalidateModels(s.id)
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
      router.invalidateModels(s.id)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: models/bulk ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/bulk`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { enabled?: boolean }
      const models = await router.modelsOf(s.id)
      store.setAllModelsEnabled(s.id, !!body.enabled, models.map((mm) => mm.id))
      router.invalidateModels(s.id)
      writeJson(res, 200, { ok: true })
    },
  })

  // ---- 通用: pool/order ----
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

  // ---- 通用 UI: 获取模型（= 强制刷新 + 核心缓存更新） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/fetch`,
    handler: async (_req, res) => {
      const models = await router.modelsOf(s.id, true)
      writeJson(res, 200, { ok: true, models })
    },
  })

  // ---- 通用: 测试模型（核心统一走 chatOnce 路径，账号池回退/冷却自动生效） ----
  routes.push({
    kind: 'exact',
    path: `${p}/models/test`,
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { id?: string; uid?: string }
      // uid 缺省/空串 = 走账号池（与面板「测试」按钮同一条路径）；给了就只测它。
      const onlyUid = typeof body.uid === 'string' && body.uid !== '' ? body.uid : undefined
      const result = await router.testModel(s.id, body.id ?? '', onlyUid)
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
      const uid = body.uid ?? ''
      const ok = await s.removeLink(uid)
      // 链接没了，它的积分缓存也得跟着走（不然删号再重登会顶着一个旧数字）
      if (ok) store.clearCredits(s.id, uid)
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
        // 全部链接都成功（含已签）才算整体成功；有任一失败 → ok:false + HTTP 400，
        // 让面板把失败如实亮出来。别学旧逻辑「有成功就算 ok」——部分失败被
        // 当成整体成功，UI 会谎报「签到完成」（2026-09-02 实测踩到）。
        const failed = results.length - succeeded - already
        const ok = failed === 0 && results.length > 0
        const payload = { ok, total: uids.length, succeeded, already, failed, results }
        writeJson(res, ok ? 200 : 400, payload)
      },
    })
  }

  return routes
}
