/**
 * opencode 供应商插件 —— 参考 9Router(open-sse) 的 opencode free 实现。
 *
 * 上游：https://opencode.ai/zen/v1（OpenAI 兼容，公开免费，无鉴权）
 *   - chat:  POST /zen/v1/chat/completions（SSE 流式 / 非流式）
 *   - models: GET  /zen/v1/models（透传，只取免费模型）
 *
 * noAuth 直连：无账号/凭证/连接池/签到 —— 通用层对它是空的，
 * 面板只显示模型卡片（连接池、签到由能力检测自动隐藏）。
 */
import type { ChatRequest, ModelInfo } from '../../router/types.ts'
import type { AccountState, ChatOnceResult, SupplierEnv, SupplierModule, SupplierStatusNow } from '../contract.ts'


export const id = 'opencode'
export const name = 'OpenCode Free'
export const priority = 0
/** 面板图标。 */
export const icon = 'data:image/png;base64,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'

const BASE = 'https://opencode.ai/zen/v1'
const MODELS_URL = `${BASE}/models`
const CHAT_URL = `${BASE}/chat/completions`
const UA = 'opencode'

/** 免费模型识别：id 以 -free 结尾，或已知不带后缀的免费模型。 */
const KNOWN_FREE = new Set(['big-pickle'])

export default function factory(env: SupplierEnv): SupplierModule {
  // 模型缓存由 dsh-router 核心统一管；插件每次拉取，失败回退上次成功结果
  let modelsCache: ModelInfo[] | undefined
  /** 上次 chatOnce 失败原因（供核心测试模型汇总诊断）。 */

  async function refreshModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(MODELS_URL, {
        headers: { 'User-Agent': UA, 'x-opencode-client': 'desktop' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return []
      const json = (await resp.json()) as { data?: Array<{ id: string }> }
      const raw = json.data ?? []
      const models: ModelInfo[] = []
      for (const m of raw) {
        if (m.id === '') continue
        if (!m.id.endsWith('-free') && !KNOWN_FREE.has(m.id)) continue
        models.push({ id: m.id })
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

    /** 当前前缀（与 loader 包装一致：store 覆盖默认值）。 */
  function currentAlias(): string {
    return env.store.get(id).alias || id
  }

  /** 剥本供应商 alias 前缀（只剥自己的，模型 id 自带的斜杠保留）。 */
  function stripAlias(model: string, alias: string): string {
    return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
  }

  /** 剥 alias 前缀（oc/xxx → xxx）后判断是否 free 模型。 */
  function isFreeModel(model: string): boolean {
    const base = stripAlias(model.trim(), currentAlias())
    return base.endsWith('-free') || KNOWN_FREE.has(base)
  }

  return {
    id,
    name,
    priority,
    icon,
    status: (): SupplierStatusNow => ({ id, name, accounts: [] }),
    listModels: (force?: boolean): Promise<ModelInfo[]> => allModels(!!force),
    // testModel 由 dsh-router 核心统一走 chatOnce 路径（无账号，无需回退）
    /** 无账号供应商：uid 恒为空，只认 free 模型。 */
    async chatOnce(_uid: string, req: ChatRequest): Promise<ChatOnceResult> {
      // 只认 free 模型，其他模型交给别的供应商
      if (!isFreeModel(req.model)) {
        const msg = `unknown free model ${JSON.stringify(req.model)}`
        return { ok: false, state: 'no_such_model', message: msg }
      }
      // 模型名规范化：剥 alias 前缀，body.model 用裸 id
      let body = req.rawBody
      try {
        const obj = JSON.parse(body) as Record<string, unknown>
        obj.model = stripAlias(String(obj.model ?? req.model), currentAlias())
        body = JSON.stringify(obj)
      } catch {
        // 保持原样
      }

      let upstream: Response
      try {
        upstream = await fetch(CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer public',
            'User-Agent': UA,
            'x-opencode-client': 'desktop',
          },
          body,
          signal: AbortSignal.timeout(120000),
        })
      } catch (err) {
        const msg = `opencode upstream: ${(err as Error).message}`
        return { ok: false, state: 'transport', message: msg }
      }

      // 非 2xx：按状态归类，核心据此冷却/换号（本供应商无号可换，直接放弃）
      if (upstream.status < 200 || upstream.status >= 300) {
        const text = await upstream.text().catch(() => '')
        const msg = `upstream ${upstream.status}: ${text.slice(0, 200)}`
        const state: AccountState =
          upstream.status === 429 ? 'rate_limit' : upstream.status === 404 ? 'unavailable' : 'unknown'
        return { ok: false, state, message: msg }
      }

      // 流式：上游已是 OpenAI SSE，原样交回核心（核心负责写响应）
      if (req.stream) {
        if (!upstream.body) {
          const msg = 'opencode upstream: empty stream body'
          return { ok: false, state: 'transport', message: msg }
        }
        return { ok: true, stream: upstream.body }
      }

      // 非流式：透传 JSON（空 body 视为上游异常）
      const text = await upstream.text().catch(() => '')
      if (text === '') {
        const msg = 'opencode upstream: empty body'
        return { ok: false, state: 'transport', message: msg }
      }
      return { ok: true, status: upstream.status, body: text }
    },
    dispose: (): void => {
      modelsCache = undefined
    },
  }
}
