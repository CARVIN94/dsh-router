/**
 * dsh-router 路由器本体：供应商注册表 + OpenAI 兼容 /v1/* 处理。
 * 仿 9router：组合 = 一组模型，请求 model 命中组合名时，按策略
 * （fallback 顺序尝试 / round-robin 轮转）选中一个模型路由。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Supplier, ChatRequest, ModelInfo, ModelWithEnabled, SupplierStatus, Combo } from './types.ts'
import type { ChatOnceResult } from '../suppliers/contract.ts'
import { AccountPool } from './account-pool.ts'
import { SupplierConfigStore } from '../supplier-config.ts'

/** 一次 chat 的追踪信息（记日志用，回答「到底用的哪个模型哪个号」）。 */
interface ChatTrace {
  /** 实际服务的账号 uid；无账号供应商为 '(no-account)'。 */
  uid?: string
  /** 失败重试次数。 */
  attempts: number
  /** 最后一次失败原因。 */
  lastError?: string
}

/** 模型列表缓存有效期。 */
const MODELS_TTL_MS = 60 * 1000

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

/**
 * 把 OpenAI SSE 流聚合成一次非流式响应体。
 *
 * 为什么核心要做这个：有些供应商**只支持流式**（如 codebuddy 强制 stream:true），
 * 于是客户端要 JSON 时也会拿到流。核心独占响应写入权，就得把这个错配吸收掉——
 * 否则客户端按 JSON 解析 `choices[0].message.tool_calls[].function.name`，
 * 而名字藏在 SSE 的 `delta` 里，解析结果就是 name 为空（下游报
 * `unknown tool ""`）。这是协议错配，不是丢数据。
 */
async function aggregateSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder()
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let content = ''
  let reasoning = ''
  let finish: string | null = null
  let usage: unknown
  // tool_calls 按 index 聚合：name 只在首个 delta 出现，arguments 逐段拼接
  const calls = new Map<number, { id?: string; type?: string; name: string; args: string }>()

  const reader = stream.getReader()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value as Uint8Array, { stream: true })
    // SSE 以空行分帧
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        let obj: Record<string, unknown>
        try { obj = JSON.parse(payload) as Record<string, unknown> } catch { continue }
        if (typeof obj.id === 'string' && obj.id !== '') id = obj.id
        if (typeof obj.model === 'string' && obj.model !== '') model = obj.model
        if (typeof obj.created === 'number') created = obj.created
        if (obj.usage !== undefined) usage = obj.usage
        const ch = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0]
        if (ch === undefined) continue
        if (typeof ch.finish_reason === 'string') finish = ch.finish_reason
        const delta = ch.delta as Record<string, unknown> | undefined
        if (delta === undefined) {
          // 少数实现把内容直接放在 message 里（非 delta）
          const msg = ch.message as Record<string, unknown> | undefined
          if (msg !== undefined) {
            if (typeof msg.content === 'string') content += msg.content
            if (typeof msg.reasoning_content === 'string') reasoning += msg.reasoning_content
          }
          continue
        }
        if (typeof delta.content === 'string') content += delta.content
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(tcs)) continue
        for (const tc of tcs) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const fn = tc.function as Record<string, unknown> | undefined
          const prev = calls.get(idx) ?? { name: '', args: '' }
          if (typeof tc.id === 'string' && tc.id !== '') prev.id = tc.id
          if (typeof tc.type === 'string') prev.type = tc.type
          if (typeof fn?.name === 'string' && fn.name !== '') prev.name = fn.name
          if (typeof fn?.arguments === 'string') prev.args += fn.arguments
          calls.set(idx, prev)
        }
      }
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    // 没名字的工具调用下游只能失败（unknown tool ""），聚合时一并丢掉
    .filter(([, c]) => c.name !== '')
    .map(([, c]) => ({
      id: c.id ?? `call_${c.name}`,
      type: c.type ?? 'function',
      function: { name: c.name, arguments: c.args },
    }))

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning !== '') message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const body: Record<string, unknown> = {
    id: id !== '' ? id : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish ?? 'stop', logprobs: null }],
  }
  if (usage !== undefined) body.usage = usage
  return JSON.stringify(body)
}

/**
 * 把 chatOnce 的结果写进 res（核心独占响应写入权）。
 * 流式：SSE 头 + pipe 上游已转好的 OpenAI SSE；非流式：原样写 JSON。
 *
 * @returns true = 响应已提交（客户端拿到东西了）；false = **一个字节都没写**
 *   （响应头也还没发），调用方可以换账号/换模型重试。
 *
 * 流式**故意推迟到第一个字节才写响应头**：上游常见「连上了但立刻断」的情况，
 * 先写头就等于把自己锁死在这一个账号上，组合就没法回退了——而客户端只拿到
 * 一个空/截断的 SSE，表现为工具调用名是空串（`unknown tool ""`）。
 *
 * 天花板：一旦写出第一个字节就绑死（HTTP 语义），中途断流只能截断，
 * 不能回退。要彻底解决得在写头前缓冲判定，代价是首字节延迟——未做。
 */
async function writeChatResult(res: ServerResponse, r: ChatOnceResult, wantsStream: boolean): Promise<boolean> {
  if (!r.ok) return false // 失败不该走到这里（核心先判 ok 才写）
  if (!('stream' in r)) {
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(r.body)
    return true
  }
  // 客户端要 JSON 但供应商只给流（如 codebuddy 强制 stream:true）→ 聚合成
  // 一次非流式响应。核心独占响应写入权，这个协议错配必须由核心吸收，
  // 否则客户端按 JSON 解析会在 SSE 的 delta 里找不到工具名。
  if (!wantsStream) {
    let body: string
    try {
      body = await aggregateSSE(r.stream)
    } catch {
      return false // 聚合失败 = 一个字节都没写，调用方可以换号重试
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
    return true
  }

  let wroteAny = false
  const writeChunk = (chunk: Uint8Array): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!wroteAny) {
        // 第一个字节到手，此刻才提交响应头
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
          ;(res as { flushHeaders: () => void }).flushHeaders()
        }
        wroteAny = true
      }
      if (res.write(chunk)) resolve()
      else res.once('drain', resolve)
    })

  // 流中途出错（客户端断开/上游断流）也要结束响应，否则连接悬挂
  const onError = (): void => {
    res.destroy()
  }
  res.once('error', onError)
  try {
    await r.stream.pipeTo(new WritableStream<Uint8Array>({ write: writeChunk }))
  } catch {
    // 流断了：一个字节都没写的话，调用方还能换号重试——交给上层决定
  } finally {
    res.removeListener('error', onError)
    if (wroteAny) res.end()
  }
  return wroteAny
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
  /** 通用供应商配置（连接池顺序/策略、模型启用、别名）。 */
  private store: SupplierConfigStore
  /** 模型列表缓存（supplierId → 模型 + 拉取时间）。插件只管拉，不缓存。 */
  private modelsCache = new Map<string, { models: ModelWithEnabled[]; fetchedAt: number }>()
  /** 请求日志出口（面板/宿主 logger）。 */
  private log: (msg: string) => void

  constructor(stateFile = '', store?: SupplierConfigStore, log?: (msg: string) => void) {
    this.combosFp = stateFile ? join(dirname(stateFile), 'combos.json') : ''
    this.store = store ?? new SupplierConfigStore(stateFile)
    this.log = log ?? ((): void => {})
    this.loadCombos()
  }

  /**
   * 请求追踪：每次 chat 记一行，回答「这个组合到底用的哪个模型和账号」。
   * 排查「组合里某个模型不稳定」全靠它——没这个就只能猜。
   * 格式刻意做成一行 grep 友好：`chat 请求model → supplier/model (uid) 结果 耗时`。
   */
  private logChat(reqModel: string, detail: string, ms: number): void {
    this.log(`chat ${JSON.stringify(reqModel)} → ${detail} ${ms}ms`)
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
            // 存储格式 = supplierId,modelId。旧数据的两种形态都在这里归一：
            // - 旧版全名 alias/id → 用别名反查供应商，存 supplierId,id
            // - 裸 id（上一版）→ 查不到供应商，保持裸 id，路由时降级为遍历
            // 用 indexOf 而非 lastIndexOf：模型 id 本身可含斜杠（如
            // deepseek-ai/xxx），剥最后一段会把命名空间吃掉。
            const models = raw.map((m) => {
              const comma = m.indexOf(',')
              if (comma > 0) return m // 已是 supplierId,modelId
              const slash = m.indexOf('/')
              if (slash <= 0) return m // 裸 id：保持，路由降级为遍历
              const alias = m.slice(0, slash)
              const modelId = m.slice(slash + 1)
              const s = this.suppliers.find((x) => x.getAlias() === alias)
              return s === undefined ? modelId : `${s.id},${modelId}`
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
    // 让 store 知道全部供应商 id，别名唯一性校验才有得比较
    this.store.sync(this.suppliers.map((s) => s.id))
  }

  /** 移除供应商（外部插件卸载时注销）。 */
  removeSupplier(id: string): boolean {
    const i = this.suppliers.findIndex((s) => s.id === id)
    if (i < 0) return false
    const [s] = this.suppliers.splice(i, 1)
    this.modelsCache.delete(id)
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

  /**
   * 取某供应商的模型（核心统一缓存）。
   *
   * 模型列表只在这里缓存一次：`/suppliers/:id/models`（供应商详情）和
   * `/combos`（组合加模型）共用。组合面板**不主动打上游**——它只是读缓存，
   * 冷启动（缓存还没建）时才拉一次；真正刷新由详情页打开或「获取模型」
   * 按钮（force）触发。
   *
   * 天花板：TTL 60s 是拍的。若上游模型列表变更很频繁，可调小；要彻底实时
   * 就得让供应商暴露 etag/版本号，目前没有这个需求。
   */
  async modelsOf(supplierId: string, force = false): Promise<ModelWithEnabled[]> {
    const s = this.suppliers.find((x) => x.id === supplierId)
    if (s === undefined) return []
    const hit = this.modelsCache.get(supplierId)
    if (!force && hit !== undefined && Date.now() - hit.fetchedAt < MODELS_TTL_MS) return hit.models
    const cfg = this.store.get(supplierId)
    const custom = new Set(cfg.custom)
    const disabled = new Set(cfg.disabled)
    const list = await Promise.resolve(s.listModels())
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
    this.modelsCache.set(supplierId, { models, fetchedAt: Date.now() })
    return models
  }

  /** 失效某供应商的模型缓存（增删改模型后调用）。 */
  invalidateModels(supplierId: string): void {
    this.modelsCache.delete(supplierId)
  }

  /** 可用模型（按供应商分组，仅启用），面板加模型用。
   *  各供应商**并行**拉取——串行会把每个上游的延迟累加起来。 */
  async supplierModels(): Promise<Array<{ supplier: { id: string; name: string; alias: string }; models: ModelWithEnabled[] }>> {
    const groups = await Promise.all(this.suppliers.map(async (s) => {
      try {
        const models = (await this.modelsOf(s.id)).filter((m) => m.enabled)
        return { supplier: { id: s.id, name: s.name, alias: s.getAlias() }, models }
      } catch {
        // 单供应商失败不影响其它
        return undefined
      }
    }))
    return groups.filter((g): g is NonNullable<typeof g> => g !== undefined)
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
  /**
   * 归一组合模型名为存储格式 `supplierId,modelId`。
   * 面板提交的是「供应商 id + 模型 id」两两组合（或旧数据的裸 id），
   * 这里只做清理与校验，不再剥掉前缀——精准调用靠的就是供应商 id。
   */
  private normalizeModelIds(models: string[]): string[] {
    return models
      .map((m) => m.trim())
      .filter((m) => m !== '')
      .map((m) => {
        const comma = m.indexOf(',')
        if (comma > 0) return m
        // 旧形态：alias/modelId 或裸 modelId → 尽量归到 supplierId,modelId
        const slash = m.indexOf('/')
        if (slash <= 0) return m
        const alias = m.slice(0, slash)
        const modelId = m.slice(slash + 1)
        const s = this.suppliers.find((x) => x.getAlias() === alias)
        return s === undefined ? modelId : `${s.id},${modelId}`
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
    // 直接调用：模型全名 = alias/model。用别名反查供应商，精准调用；
    // 别名查不到（拼错 / 供应商没加载）才退化为遍历，保持旧行为可用。
    const slash = req.model.indexOf('/')
    const alias = slash > 0 ? req.model.slice(0, slash) : ''
    const target = alias === '' ? undefined : this.supplierByAlias(alias)
    if (target !== undefined) {
      const served = await this.chatWithTarget(target, req, res)
      if (served) return
      writeJson(res, 503, openAIError('no_healthy_supplier', `supplier ${JSON.stringify(target.id)}: all accounts unavailable`))
      return
    }
    const served = await this.chatWithModel(req, res, req.model)
    if (served) return
    writeJson(res, 503, openAIError('no_healthy_supplier', 'all suppliers unavailable'))
  }

  /** 调指定供应商。
   *  模型名**原样**传给插件（不在这剥 alias/）——插件自己认得自己的别名
   *  （如 traework 会剥第一段）。核心在这剥就会剥两次，把模型 id 里的
   *  命名空间（如 org/name）吃掉。 */
  private async chatWithTarget(s: Supplier, req: ChatRequest, res: ServerResponse): Promise<boolean> {
    return await this.chatWithModel(req, res, `${s.id},${req.model}`)
  }

  /** 把 model 改写为组合选中的模型名后，找对应的供应商 + 账号（策略全在核心）。
   *
   *  `model` 形如 `supplierId,modelId`（组合的存储格式）：直接用 supplierId 定位，
   *  不再挨个问供应商「这是不是你的模型」——精准调用，也避免同名模型串台。
   *  兼容旧的裸 `modelId`（没有逗号）：降级为遍历，行为同以前。
   */
  private async chatWithModel(req: ChatRequest, res: ServerResponse, model: string): Promise<boolean> {
    const comma = model.indexOf(',')
    const supplierId = comma > 0 ? model.slice(0, comma) : undefined
    // 组合存的是供应商 id，但插件认的是自己的模型 id
    const modelId = comma > 0 ? model.slice(comma + 1) : model

    const clone: ChatRequest = { ...req, model: modelId }
    try {
      const obj = JSON.parse(req.rawBody) as Record<string, unknown>
      obj.model = modelId
      clone.rawBody = JSON.stringify(obj)
    } catch {
      clone.rawBody = req.rawBody
    }

    if (supplierId !== undefined) {
      // 精准：只调这一个供应商。查不到就是配置错了，直接失败（不遍历兜底——
      // 遍历会让拼错的 id 静默落到别的供应商上，更难查）
      const s = this.suppliers.find((x) => x.id === supplierId)
      if (s === undefined) {
        this.logChat(req.model, `supplier ${JSON.stringify(supplierId)} 不存在`, 0)
        return false
      }
      const t0 = Date.now()
      const trace: ChatTrace = { attempts: 0 }
      const served = await this.chatWithSupplier(s, clone, res, trace)
      this.logChat(req.model, served
        ? `${s.id}/${modelId} (${trace.uid ?? '?'}) ok${trace.attempts > 0 ? ` 重试${trace.attempts}次` : ''}`
        : `${s.id}/${modelId} 失败 ${trace.lastError ?? 'no account'}`, Date.now() - t0)
      return served
    }

    // 旧格式裸模型 id：退化为遍历
    for (const s of this.suppliers) {
      const served = await this.chatWithSupplier(s, clone, res)
      if (served) return true
    }
    return false
  }

  /** 按别名找供应商（对外模型全名 = alias/model）。别名唯一，故最多命中一个。 */
  supplierByAlias(alias: string): Supplier | undefined {
    return this.suppliers.find((s) => s.getAlias() === alias)
  }

  /**
   * 单个供应商内遍历账号（核心策略）：选号 → 调 chatOnce → 按返回的
   * AccountState 处置 → 失败换号；写响应只在成功后发生。
   *
   * 流式**推迟到第一个字节才写响应头**，所以「上游刚连上就断」这种情况
   * 还能换号重试；一旦写出第一个字节就绑死（HTTP 语义，9router 同样如此），
   * 之后出错不再换号——要彻底能回退就得在写头前缓冲判定，代价是首字节
   * 延迟，目前未做。
   */
  private async chatWithSupplier(s: Supplier, req: ChatRequest, res: ServerResponse, trace?: ChatTrace): Promise<boolean> {
    const pool = s.pool
    const cfg = this.store.get(s.id)
    // 无账号供应商：直接调一次（uid 传空，插件忽略）
    if (s.accounts !== undefined && s.accounts().length === 0) {
      const r = await s.chatOnce('', req)
      if (!r.ok) {
        if (r.state === 'no_such_model') return false // 不是我的模型：换供应商，不记账
        pool.noteFailure('', r.state, r.message)
        return false
      }
      if (trace !== undefined) trace.uid = '(no-account)'
      return await writeChatResult(res, r, req.stream)
    }
    // 试过的号不再选：某些失败状态既不冷却也不计数（如模型不属于本供应商），
    // 不排除试过的就会原地打转——死循环等于整个服务挂住。
    const tried = new Set<string>()
    for (;;) {
      const uid = pool.pick(s.accounts().filter((a) => !tried.has(a.uid)), cfg.poolOrder, cfg.poolStrategy)
      if (uid === undefined) return false
      tried.add(uid)
      const r = await s.chatOnce(uid, req)
      if (!r.ok) {
        // 模型不属于本供应商：整个供应商都跳过，换号重试没有意义，
        // 也不能记在账号头上（否则无关账号会被攒够错误冷却掉）
        if (r.state === 'no_such_model') {
          if (trace !== undefined) trace.lastError = 'no_such_model'
          return false
        }
        pool.noteFailure(uid, r.state, r.message)
        if (trace !== undefined) {
          trace.attempts += 1
          trace.lastError = `${r.state}: ${r.message}`
        }
        continue
      }
      pool.noteSuccess(uid)
      if (trace !== undefined) trace.uid = uid
      const committed = await writeChatResult(res, r, req.stream)
      // 一个字节都没写（上游刚连上就断）→ 这个号不算数，换下一个重试
      if (committed) return true
      pool.noteFailure(uid, 'transport', 'stream failed before first byte')
      if (trace !== undefined) {
        trace.attempts += 1
        trace.lastError = 'stream failed before first byte'
      }
    }
  }

  /** 测试某供应商的某模型是否可用。
   *  走真实的账号遍历 + chatOnce 路径：账号池回退/冷却由核心实现，自动生效；
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
      served = await this.chatWithSupplier(s, req, sink)
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
