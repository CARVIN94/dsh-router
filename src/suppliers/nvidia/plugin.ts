/**
 * nvidia 供应商插件 —— 参考 9Router(open-sse) 的 nvidia 实现。
 *
 * 上游：https://integrate.api.nvidia.com/v1（OpenAI 兼容）
 *   - chat:  POST /v1/chat/completions（SSE 流式 / 非流式）
 *   - models: GET  /v1/models（公开，无需鉴权，返回全量模型）
 *
 * API key 账号：走「添加链接 + 连接池」（同 openrouter），弹窗填名字+key，
 * 一个供应商可有多个命名 key，按池顺序/策略尝试。凭证存通用 CredentialStore
 * （SQLite：auths/credentials.sqlite，{ name, apiKey }）。key 有效性用 chat 探测
 * （无 key → 400，无效 key → 401，有效 → 200）。
 *
 * 模型不内置、不缓存：listModels 每次从上游 /v1/models 拉取（全量，不过滤），
 * 缓存由 dsh-router 核心统一管。
 */
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, SupplierStatus } from '../../router/types.ts'
import type { SupplierEnv, SupplierModule } from '../contract.ts'

export const id = 'nvidia'
export const name = 'NVIDIA NIM'
export const priority = 20 // 同 9Router：免费直连(opencode=0)之后
/** 面板图标（9router 提供的 logo）。 */
export const icon = 'http://localhost:20128/providers/nvidia.png'

const BASE = 'https://integrate.api.nvidia.com/v1'
const MODELS_URL = `${BASE}/models`
const CHAT_URL = `${BASE}/chat/completions`
const COOL_DOWN_MS = 60 * 1000 // 失败冷却 60s


/** 剥 alias 前缀（nv/xxx → xxx）。 */
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
  /** 上次 chatCompletions 失败原因（供核心测试模型汇总诊断）。 */
  let lastErr: string | undefined
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
        headers: { 'User-Agent': 'dsh-router' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return []
      const json = (await resp.json()) as { data?: Array<{ id: string; context_length?: number }> }
      const raw = json.data ?? []
      const models: ModelInfo[] = []
      const ids = new Set<string>()
      for (const m of raw) {
        if (m.id === '' || ids.has(m.id)) continue
        ids.add(m.id)
        const entry: ModelInfo = { id: m.id }
        if ((m.context_length ?? 0) > 0) entry.context_length = Math.round((m.context_length ?? 0) / 1000)
        models.push(entry)
      }
      if (models.length > 0) modelsCache = models
      return models
    } catch {
      return modelsCache ?? []
    }
  }

  async function allModels(force: boolean): Promise<ModelInfo[]> {
    return refreshModels()
  }

  /** key 有效性探测：chat 接口无 key → 400，无效 key → 401，有效 → 200。 */
  async function probeKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const probe = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-router' },
      body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b', messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    })
    if (probe.ok) return { ok: true }
    const text = await probe.text().catch(() => '')
    return { ok: false, error: `key 无效: ${probe.status} ${text.slice(0, 200)}` }
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
    getAlias: (): string => 'nv',
    async addApiKey(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> {
      const key = input.apiKey.trim()
      if (key === '') return { ok: false, error: 'API key 不能为空' }
      try {
        const r = await probeKey(key)
        if (!r.ok) return r
      } catch (err) {
        return { ok: false, error: `验证失败: ${(err as Error).message}` }
      }
      // uid：key-<序号>，避免重复
      let n = listKeys().length + 1
      let uid = `key-${n}`
      while (getKey(uid) !== undefined) uid = `key-${++n}`
      env.credentials.save(id, uid, { name: input.name.trim() || `Key ${n}`, apiKey: key })
      env.log(`nvidia add api key ${uid}`)
      return { ok: true, account: { uid, nickname: input.name.trim() || `Key ${n}` } }
    },
    async removeLink(uid: string): Promise<boolean> {
      if (getKey(uid) === undefined) return false
      env.credentials.remove(id, uid)
      cooling.delete(uid)
      return true
    },
    // testModel 由 dsh-router 核心统一走 chatCompletions 路径（账号池回退/冷却自动生效）
    lastError: (): string | undefined => lastErr,
    async chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean> {
      const base = stripAlias(req.model)
      if (!(await allModels(false)).some((m) => m.id === base)) {
        lastErr = `unknown model ${JSON.stringify(req.model)}`
        return false
      }
      const keys = orderedKeys().filter(({ uid }) => !isCooling(uid))
      if (keys.length === 0) {
        lastErr = '所有 key 都在冷却中（稍后重试）'
        return false // 无健康 key → 路由器 fallback
      }
      lastErr = undefined

      let body = req.rawBody
      try {
        const obj = JSON.parse(body) as Record<string, unknown>
        obj.model = base
        body = JSON.stringify(obj)
      } catch {
        // 保持原样
      }

      for (const { uid, acct } of keys) {
        let upstream: Response
        try {
          upstream = await fetch(CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acct.apiKey}`, 'User-Agent': 'dsh-router' },
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
      env.log(`nvidia chat failed: ${lastErr}`)
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
