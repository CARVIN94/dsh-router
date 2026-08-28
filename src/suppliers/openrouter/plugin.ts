/**
 * openrouter 供应商插件 —— 参考 9Router(open-sse) 的 openrouter 实现。
 *
 * 上游：https://openrouter.ai/api/v1（OpenAI 兼容）
 *   - chat:  POST /api/v1/chat/completions（SSE 流式 / 非流式）
 *   - models: GET  /api/v1/models（过滤免费模型：pricing 全 0 + context ≥ 200k）
 *
 * API key 账号：走「添加链接 + 连接池」（同 traework 账号模型），弹窗填名字+key，
 * 一个供应商可有多个命名 key，按池顺序/策略尝试。凭证存通用 CredentialStore
 * （SQLite：auths/credentials.sqlite，{ name, apiKey }）。
 */
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, SupplierStatus } from '../../router/types.ts'
import type { SupplierEnv, SupplierModule } from '../contract.ts'

export const id = 'openrouter'
export const name = 'OpenRouter'
export const priority = 10 // 免费直连(opencode=0)之后
/** 面板图标。 */
export const icon = 'data:image/png;base64,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'

const BASE = 'https://openrouter.ai/api/v1'
const MODELS_URL = `${BASE}/models`
const CHAT_URL = `${BASE}/chat/completions`
const COOL_DOWN_MS = 60 * 1000 // 失败冷却 60s

/** 免费模型过滤（同 9Router openrouter-free）：pricing 全 0 且 context ≥ 200k。 */
function isFreeModelMeta(m: { pricing?: { prompt?: string; completion?: string }; context_length?: number }): boolean {
  return (
    m.pricing?.prompt === '0' &&
    m.pricing?.completion === '0' &&
    (m.context_length ?? 0) >= 200000
  )
}

/** 剥 alias 前缀（or/xxx → xxx）。 */
function stripAlias(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

interface ApiKeyAccount {
  name: string
  apiKey: string
}

export default function factory(env: SupplierEnv): SupplierModule {
  // 模型缓存由 dsh-router 核心统一管；插件每次拉取，失败回退上次成功结果
  let modelsCache: ModelInfo[] | undefined
  let freeIds = new Set<string>()
  /** 失败冷却：uid → until(ms)。 */
  const cooling = new Map<string, number>()

  function listKeys(): string[] {
    return env.credentials.list(id)
  }

  function getKey(uid: string): ApiKeyAccount | undefined {
    return env.credentials.get<ApiKeyAccount>(id, uid)
  }

  /** 账号顺序：池顺序优先，未配置按凭证原始顺序。 */
  function orderedKeys(): Array<{ uid: string; acct: ApiKeyAccount }> {
    const byUid = new Map(listKeys().map((uid) => [uid, uid] as const))
    const order = env.store.get(id).poolOrder
    const uids = [...order.filter((u) => byUid.has(u)), ...listKeys().filter((u) => !order.includes(u))]
    return uids.map((uid) => ({ uid, acct: getKey(uid)! })).filter((x) => x.acct !== undefined)
  }

  function isCooling(uid: string, now = Date.now()): boolean {
    return (cooling.get(uid) ?? 0) > now
  }

  async function refreshModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(MODELS_URL, {
        headers: { 'User-Agent': 'dsh-router', 'HTTP-Referer': 'https://endpoint-proxy.local', 'X-Title': 'dsh-router' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return []
      const json = (await resp.json()) as { data?: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string }; context_length?: number }> }
      const raw = json.data ?? []
      const models: ModelInfo[] = []
      const ids = new Set<string>()
      for (const m of raw) {
        if (m.id === '' || !isFreeModelMeta(m)) continue
        if (ids.has(m.id)) continue
        ids.add(m.id)
        const entry: ModelInfo = { id: m.id }
        if ((m.context_length ?? 0) > 0) entry.context_length = Math.round((m.context_length ?? 0) / 1000)
        models.push(entry)
      }
      if (models.length > 0) {
        modelsCache = models
        freeIds = ids
      }
      return models
    } catch {
      return modelsCache ?? []
    }
  }

  async function allModels(force: boolean): Promise<ModelInfo[]> {
    return refreshModels()
  }

  return {
    id,
    name,
    priority,
    icon,
    status: (): SupplierStatus => {
      const now = Date.now()
      const accounts = orderedKeys().map(({ uid, acct }) => ({
        uid,
        nickname: acct.name || 'API Key',
        credits: 0,
        cooling: isCooling(uid, now),
        disabled: false,
        err_count: 0,
      }))
      return { id, name, accounts }
    },
    listModels: (force?: boolean): Promise<ModelInfo[]> => allModels(!!force),
    getAlias: (): string => 'or',
    async addApiKey(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> {
      const key = input.apiKey.trim()
      if (key === '') return { ok: false, error: 'API key 不能为空' }
      // 验证有效性：GET /api/v1/key 需要鉴权，无效 key 返回 401
      try {
        const probe = await fetch(`${BASE}/key`, {
          headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'dsh-router' },
          signal: AbortSignal.timeout(15000),
        })
        if (!probe.ok) {
          const text = await probe.text().catch(() => '')
          return { ok: false, error: `key 无效: ${probe.status} ${text.slice(0, 200)}` }
        }
      } catch (err) {
        return { ok: false, error: `验证失败: ${(err as Error).message}` }
      }
      // uid：key-<序号>，避免重复
      let n = listKeys().length + 1
      let uid = `key-${n}`
      while (getKey(uid) !== undefined) uid = `key-${++n}`
      env.credentials.save(id, uid, { name: input.name.trim() || `Key ${n}`, apiKey: key })
      env.log(`openrouter add api key ${uid}`)
      return { ok: true, account: { uid, nickname: input.name.trim() || `Key ${n}` } }
    },
    async removeLink(uid: string): Promise<boolean> {
      if (getKey(uid) === undefined) return false
      env.credentials.remove(id, uid)
      cooling.delete(uid)
      return true
    },
    async testModel(mid: string): Promise<{ ok: boolean; error?: string }> {
      const base = stripAlias(mid)
      const keys = orderedKeys()
      if (keys.length === 0) return { ok: false, error: '未添加 API key（点「添加链接」配置）' }
      if (!freeIds.has(base) && !(await allModels(false)).some((m) => m.id === base)) {
        return { ok: false, error: `unknown free model ${JSON.stringify(mid)}` }
      }
      for (const { acct } of keys) {
        try {
          const resp = await fetch(CHAT_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${acct.apiKey}`,
              'HTTP-Referer': 'https://endpoint-proxy.local',
              'X-Title': 'dsh-router',
            },
            body: JSON.stringify({ model: base, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
            signal: AbortSignal.timeout(30000),
          })
          if (resp.ok) return { ok: true }
          const body = await resp.text().catch(() => '')
          return { ok: false, error: `upstream ${resp.status}: ${body.slice(0, 200)}` }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
      return { ok: false, error: 'no api key' }
    },
    async chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean> {
      const base = stripAlias(req.model)
      if (!freeIds.has(base) && !(await allModels(false)).some((m) => m.id === base)) return false
      const keys = orderedKeys().filter(({ uid }) => !isCooling(uid))
      if (keys.length === 0) return false // 无健康 key → 路由器 fallback

      let body = req.rawBody
      try {
        const obj = JSON.parse(body) as Record<string, unknown>
        obj.model = base
        body = JSON.stringify(obj)
      } catch {
        // 保持原样
      }

      let lastErr = ''
      for (const { uid, acct } of keys) {
        let upstream: Response
        try {
          upstream = await fetch(CHAT_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${acct.apiKey}`,
              'HTTP-Referer': 'https://endpoint-proxy.local',
              'X-Title': 'dsh-router',
            },
            body,
            signal: AbortSignal.timeout(120000),
          })
        } catch (err) {
          cooling.set(uid, Date.now() + COOL_DOWN_MS)
          lastErr = (err as Error).message
          continue
        }
        // 非 2xx：冷却该 key，试下一个
        if (upstream.status < 200 || upstream.status >= 300) {
          cooling.set(uid, Date.now() + COOL_DOWN_MS)
          const text = await upstream.text().catch(() => '')
          lastErr = `upstream ${upstream.status}: ${text.slice(0, 120)}`
          continue
        }
        // 成功：透传（流式 SSE 或 JSON）
        if (req.stream) {
          res.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          if (!upstream.body) {
            res.end()
            return true
          }
          const reader = upstream.body.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(Buffer.from(value))
              if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
                ;(res as { flushHeaders: () => void }).flushHeaders()
              }
            }
          } finally {
            reader.releaseLock()
          }
          res.end()
          return true
        }
        const text = await upstream.text().catch(() => '')
        let status = upstream.status
        if (status === 200 && text === '') status = 502
        try {
          writeJson(res, status, JSON.parse(text))
        } catch {
          writeJson(res, status, { error: { message: text.slice(0, 500), type: 'api_error', code: 'upstream_error' } })
        }
        return true
      }
      // 所有 key 都失败：记录日志，返回 false 让路由器 fallback
      env.log(`openrouter chat failed: ${lastErr}`)
      return false
    },
    dispose: (): void => {
      modelsCache = undefined
    },
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}
