/**
 * dsh-router 路由器本体：供应商注册表 + OpenAI 兼容 /v1/* 处理。
 * 仿 9router：组合 = 一组模型，请求 model 命中组合名时，按策略
 * （fallback 顺序尝试 / round-robin 轮转）选中一个模型路由。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Supplier, ChatRequest, ModelInfo, ModelWithEnabled, SupplierStatus, Combo } from './types.ts'

function openAIError(code: string, msg: string): Record<string, unknown> {
  return { error: { message: msg, type: 'api_error', code } }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 丢弃响应的假 ServerResponse（测试模型用：记录状态+内容，用于判定成败）。 */
function sinkRes(): ServerResponse & { status(): number; body(): string } {
  let status = 200
  let text = ''
  const self = {
    headersSent: false,
    writableEnded: false,
    writeHead: (code: number): unknown => {
      status = code
      return self
    },
    write: (chunk?: unknown): boolean => {
      if (chunk !== undefined) text += String(chunk)
      return true
    },
    end: (chunk?: unknown): unknown => {
      if (chunk !== undefined) text += String(chunk)
      return self
    },
    flushHeaders: (): void => {},
    status: (): number => status,
    body: (): string => text,
  }
  return self as unknown as ServerResponse & { status(): number; body(): string }
}

/** 从上游响应体提取错误信息（OpenAI {error:{message}} 或 {code,msg}/{message}）。 */
function extractUpstreamError(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; message?: string; msg?: string; code?: number }
    if (typeof j.error?.message === 'string') return j.error.message
    if (typeof j.message === 'string') return j.message
    if (typeof j.msg === 'string') return j.msg
  } catch {
    // 非 JSON（可能是 SSE 文本）→ 走下面截断
  }
  return body.slice(0, 200)
}

/** 路由器。 */
export class Router {
  private suppliers: Supplier[] = []
  private combosFp = ''
  private customCombos: Combo[] = []
  /** round-robin 轮转游标（按组合 id 记忆）。 */
  private rrCursors = new Map<string, number>()

  constructor(stateFile = '') {
    this.combosFp = stateFile ? join(dirname(stateFile), 'combos.json') : ''
    this.loadCombos()
  }

  private loadCombos(): void {
    if (this.combosFp === '') return
    try {
      const f = JSON.parse(readFileSync(this.combosFp, 'utf8')) as { combos?: Combo[] }
      if (Array.isArray(f.combos)) {
        // 兼容旧格式：steps(供应商) → models(模型)；无 strategy 默认 fallback。
        this.customCombos = f.combos
          .filter((c) => typeof c.id === 'string' && c.id !== '')
          .map((c) => {
            const old = c as unknown as { steps?: Array<{ supplier: string }> }
            const raw = Array.isArray(c.models)
              ? c.models.filter((m) => typeof m === 'string' && m !== '')
              : Array.isArray(old.steps)
                ? old.steps
                    .map((s) => s.supplier)
                    .filter((m) => typeof m === 'string' && m !== '')
                : []
            // 兼容旧版存的全名 alias/id：剥掉第一段前缀存裸 id（前缀随供应商动态变）。
            // 用 indexOf 而非 lastIndexOf：模型 id 本身可含斜杠（如 nvidia 的
            // deepseek-ai/xxx），剥最后一段会把命名空间吃掉。
            const models = raw.map((m) => {
              const slash = m.indexOf('/')
              return slash >= 0 ? m.slice(slash + 1) : m
            })
            return {
              id: c.id,
              name: typeof c.name === 'string' ? c.name : c.id,
              strategy: c.strategy === 'round-robin' ? 'round-robin' as const : 'fallback' as const,
              models,
            }
          })
          .filter((c) => c.models.length > 0)
      }
    } catch {
      // 无文件或损坏 → 空
    }
  }

  private saveCombos(): void {
    if (this.combosFp === '') return
    try {
      const dir = dirname(this.combosFp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const raw = JSON.stringify({ combos: this.customCombos }, null, 2)
      const tmp = this.combosFp + '.tmp'
      writeFileSync(tmp, raw, { mode: 0o600 })
      renameSync(tmp, this.combosFp)
    } catch {
      // 持久化失败不阻断
    }
  }

  add(supplier: Supplier): void {
    this.suppliers.push(supplier)
    this.suppliers.sort((a, b) => a.priority - b.priority)
  }

  /** 移除供应商（外部插件卸载时注销）。 */
  removeSupplier(id: string): boolean {
    const i = this.suppliers.findIndex((s) => s.id === id)
    if (i < 0) return false
    const [s] = this.suppliers.splice(i, 1)
    s?.dispose()
    return true
  }

  /** 返回全部供应商状态（面板用）。 */
  status(): { suppliers: SupplierStatus[] } {
    return { suppliers: this.suppliers.map((s) => s.status()) }
  }

  /** 供应商前缀信息（组合模型全名 = alias/id，展示时动态拼接）。 */
  aliases(): Array<{ id: string; name: string; alias: string }> {
    return this.suppliers.map((s) => ({ id: s.id, name: s.name, alias: s.getAlias() }))
  }

  /**
   * OpenAI 兼容模型列表（/v1/models）：组合（自动带出，不可改）+ 手动添加的模型。
   * pi-ai 等 DSH provider 通过它发现 Router 的模型目录。
   */
  async listModels(): Promise<ModelInfo[]> {
    const seen = new Set<string>()
    const out: ModelInfo[] = []
    const combos = await this.combos()
    for (const c of combos) {
      if (!seen.has(c.name)) {
        seen.add(c.name)
        out.push({ id: c.name })
      }
    }
    for (const s of this.suppliers) {
      try {
        const ids = s.customModelIds?.()
        for (const id of ids ?? []) {
          if (!seen.has(id)) {
            seen.add(id)
            out.push({ id })
          }
        }
      } catch {
        // 单供应商失败不影响其它
      }
    }
    return out
  }

  /** 组合列表（面板用）：用户自定义组合。 */
  async combos(): Promise<Combo[]> {
    return [...this.customCombos]
  }

  /** 可用模型（按供应商分组，仅启用），面板加模型用。 */
  async supplierModels(): Promise<Array<{ supplier: { id: string; name: string; alias: string }; models: ModelWithEnabled[] }>> {
    const out: Array<{ supplier: { id: string; name: string; alias: string }; models: ModelWithEnabled[] }> = []
    for (const s of this.suppliers) {
      try {
        const models = (await s.modelsWithEnabled()).filter((m) => m.enabled)
        out.push({ supplier: { id: s.id, name: s.name, alias: s.getAlias() }, models })
      } catch {
        // 单供应商失败不影响其它
      }
    }
    return out
  }

  private validModels(models: string[]): boolean {
    return Array.isArray(models) && models.length > 0 && models.every((m) =>
      typeof m === 'string' && m !== '')
  }

  private validStrategy(strategy: string | undefined): strategy is 'fallback' | 'round-robin' {
    return strategy === 'fallback' || strategy === 'round-robin'
  }

  /** 组合模型统一存裸 id：剥掉 alias/ 前缀（前缀随供应商动态变）。
   *  只剥「已知 alias + /」开头的前缀——模型 id 本身可以含斜杠
   *  （如 nvidia 的 `deepseek-ai/deepseek-v4-flash-0731`），用 lastIndexOf 会把
   *  命名空间一起吃掉，后面请求必然 404。 */
  private normalizeModelIds(models: string[]): string[] {
    const aliases = this.suppliers.map((s) => s.getAlias()).filter((a) => a !== '')
    return models.map((m) => {
      const prefix = aliases.find((a) => m.startsWith(`${a}/`))
      return prefix === undefined ? m : m.slice(prefix.length + 1)
    })
  }

  /** 创建组合（name 唯一，非 default）。 */
  createCombo(name: string, strategy: string, models: string[]): { ok: boolean; error?: string; combo?: Combo } {
    const clean = name.trim()
    if (clean === '' || clean === 'default') return { ok: false, error: '组合名无效' }
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) return { ok: false, error: '组合名只能含字母、数字、-、_ 和 .' }
    if (this.customCombos.some((c) => c.name === clean)) return { ok: false, error: `组合 ${clean} 已存在` }
    if (!this.validModels(models)) return { ok: false, error: '至少需要一个模型' }
    if (!this.validStrategy(strategy)) return { ok: false, error: '策略无效' }
    const combo: Combo = { id: clean, name: clean, strategy, models: this.normalizeModelIds(models) }
    this.customCombos.push(combo)
    this.saveCombos()
    return { ok: true, combo }
  }

  /** 更新组合（按 id）。 */
  updateCombo(id: string, name: string, strategy: string, models: string[]): { ok: boolean; error?: string } {
    const target = this.customCombos.find((c) => c.id === id)
    if (!target) return { ok: false, error: '组合不存在' }
    const clean = name.trim()
    if (clean === '' || clean === 'default') return { ok: false, error: '组合名无效' }
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) return { ok: false, error: '组合名只能含字母、数字、-、_ 和 .' }
    if (this.customCombos.some((c) => c.id !== id && c.name === clean)) return { ok: false, error: `组合 ${clean} 已存在` }
    if (!this.validModels(models)) return { ok: false, error: '至少需要一个模型' }
    if (!this.validStrategy(strategy)) return { ok: false, error: '策略无效' }
    target.name = clean
    target.strategy = strategy
    target.models = this.normalizeModelIds(models)
    this.saveCombos()
    return { ok: true }
  }

  /** 删除组合（按 id，default 不可删）。 */
  removeCombo(id: string): { ok: boolean; error?: string } {
    if (id === 'default') return { ok: false, error: '默认组合不可删除' }
    const idx = this.customCombos.findIndex((c) => c.id === id)
    if (idx === -1) return { ok: false, error: '组合不存在' }
    this.customCombos.splice(idx, 1)
    this.saveCombos()
    return { ok: true }
  }

  /** 按组合名查组合（含 `/` 的模型名不匹配）。 */
  comboByName(name: string): Combo | undefined {
    if (name.includes('/')) return undefined
    return this.customCombos.find((c) => c.name === name)
  }

  /**
   * 处理 /v1/chat/completions。
   * - model 命中组合名 → 在组合模型里按策略选一个，交给供应商；失败按回退顺序尝试剩余模型。
   * - 否则 → 依次尝试供应商，直到某个返回 true（已写响应）或全部返回 false。
   */
  async chatCompletions(req: ChatRequest, res: ServerResponse): Promise<void> {
    const combo = this.comboByName(req.model)
    if (combo) {
      // 组合：按策略选起点，然后按组合模型顺序回退
      const start = combo.strategy === 'round-robin'
        ? (this.rrCursors.get(combo.id) ?? 0) % combo.models.length
        : 0
      if (combo.strategy === 'round-robin') this.rrCursors.set(combo.id, (this.rrCursors.get(combo.id) ?? 0) + 1)
      for (let i = 0; i < combo.models.length; i++) {
        const model = combo.models[(start + i) % combo.models.length]
        if (model === undefined) continue
        const served = await this.chatWithModel(req, res, model)
        if (served) return
      }
      writeJson(res, 503, openAIError('no_healthy_supplier', `combo ${JSON.stringify(req.model)}: all models unavailable`))
      return
    }
    for (const s of this.suppliers) {
      const served = await s.chatCompletions(req, res)
      if (served) return
    }
    writeJson(res, 503, openAIError('no_healthy_supplier', 'all suppliers unavailable'))
  }

  /** 把 model 改写为组合选中的模型名后尝试供应商。 */
  private async chatWithModel(req: ChatRequest, res: ServerResponse, model: string): Promise<boolean> {
    const clone: ChatRequest = { ...req, model }
    try {
      const obj = JSON.parse(req.rawBody) as Record<string, unknown>
      obj.model = model
      clone.rawBody = JSON.stringify(obj)
    } catch {
      clone.rawBody = req.rawBody
    }
    for (const s of this.suppliers) {
      const served = await s.chatCompletions(clone, res)
      if (served) return true
    }
    return false
  }

  /** 测试某供应商的某模型是否可用。
   *  走真实 chatCompletions 路径：账号池回退/冷却由供应商内部实现，自动生效；
   *  响应丢弃到 sink，限定单一供应商（不跨供应商回退）。 */
  async testModel(supplierId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.suppliers.find((x) => x.id === supplierId)
    if (s === undefined) return { ok: false, error: `unknown supplier ${JSON.stringify(supplierId)}` }
    const sink = sinkRes()
    const req: ChatRequest = {
      model,
      stream: false,
      rawBody: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
    }
    let served = false
    try {
      served = await s.chatCompletions(req, sink)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    // 供应商可能「服务了但写出错误响应」（如 opencode：唯一能处理该模型的供应商，错误自己上报）
    if (served && sink.status() < 400) return { ok: true }
    const fromSink = served && sink.status() >= 400 ? extractUpstreamError(sink.body()) : ''
    const detail = fromSink !== '' ? fromSink : s.lastError?.()
    return {
      ok: false,
      error: detail !== undefined && detail !== ''
        ? `${detail}（账号/额度/限流问题，非模型问题）`
        : '所有账号都失败或账号都在冷却中（稍后重试）',
    }
  }

  dispose(): void {
    for (const s of this.suppliers) s.dispose()
    this.suppliers = []
  }
}
