/**
 * dsh-router 路由器本体：供应商注册表 + OpenAI 兼容 /v1/* 处理。
 * 仿 9router：组合 = 一组模型，请求 model 命中组合名时，作为降级链
 * 按序尝试选中一个模型路由（无策略旋钮，见 docs/pool-sticky-block.md §10）。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Supplier, ChatRequest, ModelInfo, ModelWithEnabled, SupplierStatus, Combo } from './types.ts'
import type { ChatOnceResult } from '../suppliers/contract.ts'
import type { AccountState } from '../suppliers/contract.ts'
import { AccountPool } from './account-pool.ts'
import { SupplierConfigStore } from '../supplier-config.ts'
import { UsageStore } from './usage-store.ts'
import { tapStreamUsage, usageFromJsonBody, withEstimates, type UsageTokens } from './usage-tokens.ts'

/** 一次 chat 的追踪信息（记日志用，回答「到底用的哪个模型哪个号」）。 */
interface ChatTrace {
  /** 实际服务的账号 uid；无账号供应商为 '(no-account)'。 */
  uid?: string
  /** 失败重试次数。 */
  attempts: number
  /** 最后一次失败原因。 */
  lastError?: string
  /** 最后一次失败的状态（组合据此判断要不要「喘口气」再降级）。 */
  lastState?: AccountState
  /** 本次选号的理由（诊断「为什么没粘住原号」）。 */
  pickWhy?: string
}

/**
 * 模型列表缓存有效期。
 *
 * 取 10 分钟而不是 60s：模型列表本来很少变（上游上新/下线才动），而每次
 * TTL 过期都会穿透到插件真打一次上游——实测冷路径 0.3~1.0s/供应商，组合页
 * 取最慢那家就是 1s+ 的白屏。拉长 TTL 直接把这个穿透频率降一个量级；真要
 * 立刻看新模型，点「获取模型」走 force 即可。
 */
const MODELS_TTL_MS = 10 * 60 * 1000

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

/**
 * 剥掉本供应商自己的 alias 前缀（只剥一层，且只认完整 `alias/` 开头）。
 *
 * 为什么不能用 lastIndexOf：模型 id 本身可以含斜杠（nvidia 的
 * `deepseek-ai/deepseek-v4-flash-0731`），剥最后一段会把命名空间吃掉，
 * 后面请求必然 404。只认「已知 alias + /」开头，其他原样返回。
 *
 * 注意：核心**只在记统计名时**用它。传给插件的 model 全名保持原样——
 * 剥前缀是插件自己的事（各供应商插件都有一份同名实现）。
 */
function stripAlias(model: string, alias: string): string {
  return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
}

/**
 * 组合降级前的「喘口气」等待：瞬时故障给上游一个恢复窗口再换下一个模型。
 *
 * 学 9router combo.js 的同名处理（注释原话：fixes: combo falls through on
 * transient 503）—— 过载的上游往往几百毫秒内就恢复，立刻换下一个模型会
 * 让整个组合在几毫秒内被打穿，最后全灭返回 503。
 *
 * 只对**瞬时**故障等：连接层失败 / 上游不可用（对应 9router 的 502/503/504）。
 * 模型不属于本供应商（no_such_model）绝不能等 —— 它不是故障，等纯属浪费。
 * 请求本身非法（bad_request）同理：换哪个模型都是同一个 400，等也是白等。
 */
const TRANSIENT_SETTLE_MS = 2_000

function isTransient(state: AccountState): boolean {
  return state === 'transport' || state === 'unavailable'
}

/**
 * **每条降级腿的首字节预算**：从进入这条腿起，多久内上游必须吐出第一个字节。
 *
 * 为什么必须有（2026-09-24 夜里 money 组合实测）：上游（codebuddy 系）额度用完 /
 * 过载时，连接照常建立、HTTP 200 响应头照常回来，**body 却一个字节都不吐**。
 * 这既不是成功也不是失败，于是
 *   - `chatOnce` 的 120s 只守「连接+响应头」，`fetch` 一返回就撤表 → 守不到 body
 *   - 核心写响应的路径也没有任何计时器 → 组合链卡在这一条腿上不动
 *   - 客户端（dsh-router 自己的 adapter）有 300s 流空闲超时，但那是「整条请求」
 *     的兜底，与降级无关
 * 实测用户干等 200 多秒手动暂停：ttfb 84s / 122s / 151s / 244s / 246s / 250s /
 * 254s / 255s，8 次全部 `ok: true`——**全都最终成功了**，只是晚了四分钟。同一批
 * 账号因为「没失败」也不冷却，下一次请求继续挑它（cb-8 连吃 248s + 155s）。
 *
 * 60s 的来历（本机 500 条真实请求的 ttfb 分布）：p50 4.1s / p95 14.9s，
 * 最大的**非停滞**值 47.7s，停滞簇从 84.5s 起 —— 60s 正落在两簇之间的空档，
 * 砍得动停滞、砍不到真实慢请求。首个字节之后**不再计时**：长生成可以跑很久。
 *
 * 为什么按「腿」而不是按「账号」计：停滞是上游级的（同一供应商的所有号一起
 * 挂）。按账号计的话，codebuddy 有 11 个号，一次请求能 11×60s = 11 分钟才轮到
 * 下一个模型；按腿计，最坏 3 条腿 × 60s ≈ 3 分钟，且期间一定会走到下一个模型。
 */
const FIRST_BYTE_BUDGET_MS = 60_000

/**
 * 给上游流套一层**首字节截止**：截止前一个字节都没来，就把这条流判失败
 * （error 出去，调用方看到「一个字节都没写」→ 换号/换模型）。
 * 第一个字节到手后立刻撤表，之后多久都不管。
 *
 * 为什么套在核心而不是插件：首字节迟迟不来时，**只有核心**能做「还没提交响应
 * → 换一条腿」的决定（插件在 `fetch` 拿到响应头那一刻就把流交出去了，
 * 谁也没法再改结果）。核心也是所有供应商唯一的收口点，套一次全都受益。
 */
export function withFirstByteDeadline(stream: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  let first = true
  /** 消费方已取消：这之后任何 ctrl.* 都会抛（流已死），必须全部跳过。 */
  let cancelled = false
  /**
   * 上游 reader 只解绑一次。wrapper 替核心持有了这个 reader，所以**必须由
   * wrapper 负责收尾**：上游正常读完 / 上游自己 error / 被取消时都解锁，
   * 否则流永久锁着，上层想 cancel 会抛 `Invalid state: ReadableStream is locked`
   * （disconnect-leak 那条判据守的就是这个；历史上由 aggregateSSE 的 finally 解锁，
   * 现在读的是 wrapper，解绑责任跟着搬过来）。
   */
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try { reader.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
  }
  /** 取消要传到底下的上游（cancel 本身会顺带解锁）。 */
  const cancelUpstream = (reason: unknown): Promise<void> => {
    if (released) return Promise.resolve()
    released = true
    return reader.cancel(reason).then(() => {}, () => {})
  }
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      // 超时标志由计时器置位：置位后**不再碰 ctrl**（流已经 error 掉了，
      // 再 close/enqueue 会抛 ERR_INVALID_STATE，把真正的失败原因盖掉）。
      let expired = false
      const timer = first
        ? setTimeout(() => {
            expired = true
            void cancelUpstream(new Error('first byte timeout'))
            try { ctrl.error(new Error(`no first byte within ${ms}ms`)) } catch { /* 已被取消 */ }
          }, ms)
        : undefined
      try {
        const { done, value } = await reader.read()
        if (expired || cancelled) return
        if (done) {
          release()
          ctrl.close()
          return
        }
        first = false
        ctrl.enqueue(value)
      } catch (e) {
        release()
        if (!expired && !cancelled) {
          try { ctrl.error(e) } catch { /* 已被取消 */ }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    // 消费方取消必须穿过这层 wrapper 传到上游（与 normalizeSSEStream 同理，
    // 不实现就等于每次客户端放弃都漏一条上游连接）。
    cancel: (reason) => {
      cancelled = true
      return cancelUpstream(reason)
    },
  })
}

/**
 * 从请求体里取 `messages`（前缀亲和的指纹输入）。解析失败/字段缺失返回
 * undefined —— 亲和拿不到输入就自动回退到块轮询，不影响路由本身。
 */
function reqMessages(rawBody: string): unknown {
  try {
    return (JSON.parse(rawBody) as { messages?: unknown }).messages
  } catch {
    return undefined
  }
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
  try {
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
  } finally {
    // 无论正常读完还是中途抛错，都要**解绑** reader：调用方（writeChatResult）
    // 在失败路径里要对同一流 cancel()，而流被锁住时 cancel 会抛
    // `Invalid state: ReadableStream is locked` —— 那样这次的连接就漏了。
    try { reader.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
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
 * 流式 SSE 逐帧归一化：剥掉上游多发一次的**空** tool_call 字段，
 * 并记住上游有没有发终止帧（`data: [DONE]`）—— 断流时核心要据此补发，
 * 见 `writeChatResult`。
 *
 * 为什么必须做：CodeBuddy 上游的工具调用第二个 delta 会**显式发空串**
 *   `{"function":{"name":"","arguments":"{...}"},"index":0}`（以及 `"id":""`）。
 * OpenAI 规范里后续 delta 应当**省略**这些字段，客户端沿用首帧的名字；
 * 而客户端（dsh）判空用的是 `name !== void 0`，空串过不了这个判断，于是首帧
 * 的 "bash" 被第二帧的 "" 冲掉 —— 工具名变空，下游报 `unknown tool ""`，
 * 而 arguments 是独立累积的，所以现象是「参数对、名字空」。
 *
 * 核心是流式响应的唯一写入方，这个上游不合规得核心吸收：把空串字段**删掉**
 * （而不是留着空串），客户端看到的就是 undefined，不会覆盖。
 *
 * 只动 tool_calls 的空 name/id，其余原样透传；逐帧流式处理，不缓冲整条流
 * （首字节延迟不受影响）。解析失败一律原样透传——宁可不改，也不能改坏。
 */
function normalizeSSEStream(stream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>
  /** 上游（或最后一帧残留）里出现过终止帧？调用方在流结束后读。 */
  sawDone: () => boolean
} {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let buf = ''
  let sawDone = false
  /** 上游 reader：cancel 时要靠它把取消传下去（见下方 cancel 分支）。 */
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const out = new ReadableStream<Uint8Array>({
    start: async (ctrl) => {
      reader = stream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value as Uint8Array, { stream: true })
          let sep: number
          // 按 SSE 空行分帧；跨 chunk 边界的不完整帧留在 buf 里等下一块
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep + 2)
            buf = buf.slice(sep + 2)
            if (isDoneFrame(frame)) sawDone = true
            ctrl.enqueue(enc.encode(fixFrame(frame)))
          }
        }
        if (buf !== '') {
          if (isDoneFrame(buf)) sawDone = true
          ctrl.enqueue(enc.encode(fixFrame(buf)))
        }
      } catch {
        // 消费方取消（客户端断开）会让挂起的 read 抛错/返回 done —— 静默收尾
      } finally {
        try { reader.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
      }
      try { ctrl.close() } catch { /* 已取消 */ }
    },
    /**
     * **取消必须往下传**：ReadableStream 的取消不会自动穿过 wrapper。
     * 不实现这个分支，客户端断开的取消就停在这里，上游 fetch body 永不 cancel
     * ——那条 TCP 连接和 in-flight 请求原样挂着（长跑一天就会累积到耗尽）。
     * 用 reader.cancel() 而不是 stream.cancel()：流已被 getReader() 锁住，
     * 直接 cancel 会抛 `Invalid state: ReadableStream is locked`。
     */
    cancel: (reason) => reader?.cancel(reason),
  })
  return { stream: out, sawDone: () => sawDone }
}

/** 一帧 SSE 里有没有终止帧（宽松匹配：跨 chunk 的残留尾帧也认）。 */
function isDoneFrame(frame: string): boolean {
  return /(^|\n)data:[ \t]*\[DONE\][ \t]*(\n|$)/.test(frame)
}

/**
 * 修一帧 SSE：剥掉**空的**（`''` 或 `null`）name/id，出任何问题都原样返回。
 *
 * 为什么 `null` 也算空：上游（OpenCode/Zen）在后续 delta 里会把首帧已给过的
 * id/name 显式重发成 `null`——`{"id":null,"function":{"name":null,"arguments":"{"}}`。
 * 下游判「有没有新值」用的是 `name !== undefined`（dsh 的 BlockAssembler 就是），
 * null 过不了这个判断、却也不该覆盖首帧：客户端会把已拿到的 "bash" 冲成 null，
 * 工具名丢失（表现为 `unknown tool ""`）。空串早就剥了，null 语义上同样是
 * 「本帧没给新值」，一并剥掉。
 */
function fixFrame(frame: string): string {
  // 绝大多数帧没有 tool_calls，先廉价字符串筛查，避免无谓的 JSON 解析
  if (!frame.includes('tool_calls')) return frame
  return frame
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line
      const payload = line.slice(6).trim()
      if (payload === '' || payload === '[DONE]') return line
      let obj: Record<string, unknown>
      try { obj = JSON.parse(payload) as Record<string, unknown> } catch { return line }
      let changed = false
      const choices = obj.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      const tcs = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          // 空串与 null 都是「本帧没给新值」，剥掉让下游沿用首帧那个
          if (tc.id === '' || tc.id === null) { delete tc.id; changed = true }
          const fn = tc.function as Record<string, unknown> | undefined
          if (fn !== null && typeof fn === 'object' && (fn.name === '' || fn.name === null)) {
            delete fn.name
            changed = true
          }
        }
      }
      return changed ? `data: ${JSON.stringify(obj)}` : line
    })
    .join('\n')
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
 * 截断时**补发终止帧**（见末尾 finally）：客户端严格等 `[DONE]`，缺了就
 * 整轮判失败，已流式吐出的内容全废。
 *
 * 天花板：一旦写出第一个字节就绑死（HTTP 语义），中途断流只能截断，
 * 不能回退。要彻底解决得在写头前缓冲判定，代价是首字节延迟——未做。
 *
 * @param firstByteTimeoutMs 上游多久内必须吐出第一个字节（见 FIRST_BYTE_BUDGET_MS）。
 *   超时按「一个字节都没写」返回 false，调用方照常换号/换模型。
 */
async function writeChatResult(
  res: ServerResponse,
  r: ChatOnceResult,
  wantsStream: boolean,
  probe?: UsageProbe,
  startedAt = 0,
  firstByteTimeoutMs = FIRST_BYTE_BUDGET_MS,
): Promise<boolean> {
  if (!r.ok) return false // 失败不该走到这里（核心先判 ok 才写）
  if (!('stream' in r)) {
    if (probe !== undefined) probe.tokens = usageFromJsonBody(r.body)
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(r.body)
    return true
  }
  // 唯一收口：两条路径（聚合 / 透传）读的都是这层「套了首字节截止」的流。
  const src = withFirstByteDeadline(r.stream, firstByteTimeoutMs)
  // 客户端要 JSON 但供应商只给流（如 codebuddy 强制 stream:true）→ 聚合成
  // 一次非流式响应。核心独占响应写入权，这个协议错配必须由核心吸收，
  // 否则客户端按 JSON 解析会在 SSE 的 delta 里找不到工具名。
  if (!wantsStream) {
    let body: string
    try {
      body = await aggregateSSE(src)
    } catch {
      // 聚合失败 = 一个字节都没写，调用方可以换号重试。
      // **但底层流必须 cancel**：aggregateSSE 内部 getReader() 消费到一半抛错时，
      // reader 只是 releaseLock()，传输层毫无察觉 —— 那条上游连接会一直挂着。
      // 不 cancel 就退化成「每次聚合失败漏一条连接」（issue #6 的路径 1）。
      await src.cancel().catch(() => {})
      return false
    }
    if (probe !== undefined) probe.tokens = usageFromJsonBody(body)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
    return true
  }

  // 流式：边透传边统计（统计在 tee 之外的旁路做，首字节延迟不受影响）
  const tapped = probe === undefined ? undefined : tapStreamUsage(src, startedAt)
  let wroteAny = false
  /** 响应已死（客户端断开/res 已销毁）：等 drain 的写入要立刻放弃，别吊死。 */
  let dead = false
  /**
   * 唤醒「等 drain 的挂起 write」。客户端断开时必须调它：那时 'drain' 永不到来，
   * 不唤醒就永远卡在 write 里，pipeTo 不 settle，finally 不执行，
   * **上游流也就永不 cancel**（= 每次客户端放弃漏一条连接）。
   */
  let releaseWait: (() => void) | undefined
  /**
   * 中止 pipeTo 的信号源（客户端断开时 abort）。
   * 单靠 `dead` 标志只能让**下一次** write 立刻返回，唤醒不了**已经挂起**的那次；
   * abort 才能让 pipeTo 立刻收尾并走它的取消路径（进而 cancel 上游）。
   */
  const abort = new AbortController()
  const writeChunk = (chunk: Uint8Array): Promise<void> =>
    new Promise<void>((resolve) => {
      if (dead) { resolve(); return }
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
      else {
        // 背压：等 drain。但连接可能在这期间断掉 —— 那时 'drain' 永不到来，
        // 得靠 release() 兜住（客户端断开时唤醒），否则这次请求会永远挂着。
        const onDrain = (): void => { res.removeListener('error', onDrain); resolve() }
        res.once('drain', onDrain)
        /** 让这个挂起的 write 立刻收尾（客户端断开时调用）。 */
        releaseWait = () => { res.removeListener('drain', onDrain); resolve() }
      }
    })

  // 客户端断开 / 流中途出错都要停手，否则连接悬挂
  const onError = (): void => {
    dead = true
    res.destroy()
  }
  res.once('error', onError)
  /**
   * **客户端断开必须被当成取消信号**：只监听 'error' 是不够的 —— 对端关闭
   * （pi-ai 的流空闲超时、用户取消、消费方提前退出）触发的是 'close'，
   * 不是 'error'。此时若不收手，pipeTo 会一直等着 drain（永不到来），
   * finally 永不执行，上游 fetch body **永不 cancel** → 那条 TCP 连接和
   * in-flight 请求原样挂着，长跑累积到耗尽（"用久了就报 connection error"）。
   */
  const onClose = (): void => {
    if (res.writableEnded) return // 正常写完的 close，不是取消
    dead = true
    releaseWait?.()
    abort.abort()
  }
  res.once('close', onClose)
  const norm = normalizeSSEStream(tapped?.stream ?? src)
  try {
    // signal 让 abort 时 pipeTo 立刻收尾（而不是等 drain）；其收尾路径会
    // cancel 源流，顺着 wrapper 的 cancel 一路传到上游 fetch body。
    await norm.stream.pipeTo(new WritableStream<Uint8Array>({ write: writeChunk }), { signal: abort.signal })
  } catch {
    // 断流/取消：一个字节都没写的话，调用方还能换号重试——交给上层决定
  } finally {
    res.removeListener('error', onError)
    res.removeListener('close', onClose)
    // 断流也要给客户端一个终止帧。客户端（dsh-llm adapter）严格等
    // `[DONE]`，缺了就整轮判失败（`SSE payload stream ended without
    // [DONE]`），已经流式吐出去的内容全部作废。上游自己发了就不重复发
    // （多发一个 [DONE] 同样坑客户端）。
    //
    // 只在**已提交响应**时补：一个字节都没写 = 还能换号重试，补了就等于
    // 把这次失败坐实成一个空响应，组合回退就没了。
    // dead（客户端已走）时也不补：对端没了，写了也没人收。
    if (wroteAny && !norm.sawDone() && !dead && !res.writableEnded && !res.destroyed) {
      await writeChunk(DONE_FRAME)
    }
    if (wroteAny && !dead) res.end()
    // 流走完才出得了 usage（上游多在最后一帧才发 usage）
    if (probe !== undefined && tapped !== undefined) {
      const got = await tapped.done()
      probe.tokens = got.usage
      probe.outputChars = got.outputChars
      probe.ttfbMs = got.ttfbMs
    }
  }
  return wroteAny
}

/** SSE 终止帧（断流兜底补发用）。 */
const DONE_FRAME = new TextEncoder().encode('data: [DONE]\n\n')

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

/** 一次请求的用量观测。由 `chatCompletions` 建，一路传到 `writeChatResult`。
 *
 *  为什么是**每个客户端请求一条**而不是每次尝试一条：组合回退会依次试多个
 *  供应商/账号，按尝试记账会把「1 个请求」记成「N 个请求」，请求数和成功率
 *  全是假的。所以 probe 唯一，成功时由 `chatWithSupplier` 回填是哪个供应商
 *  和账号成的，最后由 `chatCompletions` 落一次账。
 */
interface UsageProbe {
  /** 客户端请求的 model（组合场景下就是组合名）。 */
  requested: string
  /** 实际服务的供应商（成功时回填）。 */
  supplier: string
  /** 实际调的模型（成功时回填）。 */
  model: string
  /** 实际服务的账号（成功时回填）。 */
  uid: string
  /** 上游给的 token（null = 上游没发，会走估算）。 */
  tokens: UsageTokens | null
  /** 输出内容字符数（上游没给输出 token 时用来估算）。 */
  outputChars: number
  /** 首字节延迟（ms）；非流式/一个字节都没收到时为 0。 */
  ttfbMs: number
  /** 请求开始时间。 */
  startedAt: number
}

/** 路由器。 */
export class Router {
  /**
   * **已装载**的全部供应商（含被开关关掉的）。关掉的仍留在列表里 —— 否则用户关掉
   * 之后它在 `/health`、面板、插件页里一起消失，开关就没有可指的对象、也没法再开。
   *
   * 真正参与路由的只有 `active` 那一份。
   */
  private suppliers: Supplier[] = []
  private combosFp = ''
  private customCombos: Combo[] = []
  /** 通用供应商配置（连接池顺序、模型启用、别名）。 */
  private store: SupplierConfigStore
  /** 模型列表缓存（supplierId → 模型 + 拉取时间）。插件只管拉，不缓存。 */
  private modelsCache = new Map<string, { models: ModelWithEnabled[]; fetchedAt: number }>()
  /**
   * 正在拉模型的供应商 → in-flight promise。
   * 组合页会同时从多个入口触发同一个供应商的刷新，不去重上游就被按 N 倍打。
   */
  private modelsInflight = new Map<string, Promise<ModelWithEnabled[]>>()
  /** 请求日志出口（面板/宿主 logger）。 */
  private log: (msg: string) => void
  /** 每条降级腿的首字节预算（ms）。只给测试一个入口，生产恒为 FIRST_BYTE_BUDGET_MS。 */
  private firstByteBudgetMs: number
  /** 用量统计（概览看板）。 */
  usage: UsageStore

  constructor(
    stateFile = '',
    store?: SupplierConfigStore,
    log?: (msg: string) => void,
    opts?: { firstByteBudgetMs?: number },
  ) {
    this.combosFp = stateFile ? join(dirname(stateFile), 'combos.json') : ''
    this.store = store ?? new SupplierConfigStore(stateFile)
    this.log = log ?? ((): void => {})
    this.firstByteBudgetMs = opts?.firstByteBudgetMs ?? FIRST_BYTE_BUDGET_MS
    this.usage = new UsageStore(stateFile)
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
        // 兼容旧格式：steps(供应商) → models(模型)；旧 strategy 字段静默忽略。
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
              const s = this.active.find((x) => x.getAlias() === alias)
              return s === undefined ? modelId : `${s.id},${modelId}`
            })
            return {
              id: c.id,
              name: typeof c.name === 'string' ? c.name : c.id,
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

  /**
   * **参与路由的供应商** —— 装载清单里开关为开的那一份，按 priority 排好。
   *
   * 这是「供应商开关」唯一的收口点：请求分发、别名反查、模型列表、组合、面板状态
   * 全部读它。关掉一个供应商 = 它从这里消失，而不是在每个调用点各写一遍判断 ——
   * 后者一定会漏（本次实测路由有 15 处读 `this.suppliers`）。
   */
  private get active(): Supplier[] {
    return this.suppliers.filter((s) => this.store.isEnabled(s.id))
  }

  /** 某供应商当前是否参与路由（面板与 API 用）。 */
  isEnabled(supplierId: string): boolean {
    return this.store.isEnabled(supplierId)
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

  /**
   * 返回全部供应商状态（面板用）。**含被开关关掉的** —— 面板要能显示它们
   * （「已关闭」），否则用户在面板上就再也看不到自己装过的供应商。
   * 开关状态由 `enabled` 字段带出，调用方自己决定要不要只留开着的。
   */
  status(): { suppliers: (SupplierStatus & { enabled: boolean })[] } {
    return {
      suppliers: this.suppliers.map((s) => ({ ...s.status(), enabled: this.store.isEnabled(s.id) })),
    }
  }

  /** 供应商前缀信息（组合模型全名 = alias/id，展示时动态拼接）。只含开着的。 */
  aliases(): Array<{ id: string; name: string; alias: string }> {
    return this.active.map((s) => ({ id: s.id, name: s.name, alias: s.getAlias() }))
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
    for (const s of this.active) {
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
   * `/combos`（组合加模型）共用。
   *
   * **过期后走 stale-while-revalidate**:先返回旧值让面板立刻有内容,后台
   * 重新拉,拉完下次请求就是新的。为什么必须这样:插件的 `listModels` 大多
   * 无条件打上游(实测冷路径 0.3~1.0s/供应商),而组合页要拉全部供应商、
   * 取最慢那家——同步等就是 1s+ 的白屏。旧值只可能「少列了新模型」,
   * 比白屏划算;想立刻看新模型点「获取模型」(force)即可。
   *
   * 只有两种情况会真的等:`force`(用户主动刷新)和**从来没有过缓存值**
   * (冷启动,没有旧值可给)。后者只发生一次。
   */
  /**
   * 组合的上下文窗口(token):组合内各模型窗口的**最小值**,拿不到就 undefined。
   *
   * 只读缓存、绝不打上游:调用方是 llm adapter 的 `resolveModel`,它在每次
   * 请求前后都可能被调用,不能为了报一个容量去触发按供应商的网络往返。
   * 冷启动(还没缓存)时给 undefined —— 自动压缩会因此跳过这一轮,下次就
   * 有了,比撒谎说一个窗口值安全。
   *
   * 单位:`ModelInfo.context_length` 存的是 **K**(供应商插件统一
   * `Math.round(tokens / 1000)`,见 codebuddy plugin),这里换算回 token。
   *
   * 取最小而不是最大:组合会按策略 fallback 到任意一个模型,按最窄的声明
   * 才能让「快满了」这件事在任何一条分支上都成立。
   */
  comboContextWindow(combo: Combo): number | undefined {
    let min: number | undefined
    for (const ref of combo.models) {
      const at = ref.indexOf(',')
      if (at < 0) continue
      const supplierId = ref.slice(0, at)
      const modelId = ref.slice(at + 1)
      const hit = this.modelsCache.get(supplierId)
      if (hit === undefined) return undefined // 这家还没缓存过,不猜
      const m = hit.models.find((x) => x.id === modelId)
      const k = m?.context_length
      if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) continue
      const tokens = Math.round(k * 1000)
      if (min === undefined || tokens < min) min = tokens
    }
    return min
  }

  async modelsOf(supplierId: string, force = false): Promise<ModelWithEnabled[]> {
    const s = this.active.find((x) => x.id === supplierId)
    if (s === undefined) return []
    const hit = this.modelsCache.get(supplierId)
    const fresh = hit !== undefined && Date.now() - hit.fetchedAt < MODELS_TTL_MS
    if (!force && fresh) return hit!.models
    // 有旧值(只是过期了):立刻返回旧值,后台刷新
    if (!force && hit !== undefined) {
      // 后台刷新的失败不能冒出来:这是 fire-and-forget,没人接
      void this.refreshModels(supplierId, s).catch(() => {})
      return hit.models
    }
    return await this.refreshModels(supplierId, s)
  }

  /**
   * 真拉一次上游并写缓存。并发调用共享同一个 in-flight promise——
   * 组合页会同时触发多个入口,不去重会把上游按 N 倍打(各家插件自己没做这层)。
   *
   * 失败时:**有旧值就退回旧值**(宁可显示几分钟前的列表,也别让面板空掉),
   * **没旧值就把错误抛回去**——调用方(`supplierModels`)据此把该供应商整个
   * 剔除,而不是显示一个「有 0 个模型」的空壳。
   */
  private refreshModels(supplierId: string, s: Supplier): Promise<ModelWithEnabled[]> {
    const inflight = this.modelsInflight.get(supplierId)
    if (inflight !== undefined) return inflight
    const p = (async (): Promise<ModelWithEnabled[]> => {
      const cfg = this.store.get(supplierId)
      const custom = new Set(cfg.custom)
      const disabled = new Set(cfg.disabled)
      const list = await Promise.resolve(s.listModels())
      const models: ModelWithEnabled[] = list.map((mm) => ({
        ...mm,
        enabled: !disabled.has(mm.id),
        custom: custom.has(mm.id) ? true : undefined,
      }))
      // 配置里有的 id，**不该因为 listModels 没返回就消失**。
      // 自定义模型与「用户禁用过的模型」都要并回显示列表：
      // 插件的 listModels 只该报「模型来源」，**启用状态归核心合并**（见
      // loader.ts 的 modelsWithEnabled 注释）。个别插件会自作主张在 listModels 里
      // 把已禁用的过滤掉 —— 那样面板的「已禁用」列表就空了，用户再也看不到自己
      // 禁用过什么，而且「全部启用」之后它们也不会回来（插件仍认为它们该被藏）。
      // 这里按配置把缺的 id 补回（context_length 拿不到就留空，不编造）。
      const seen = new Set(models.map((mm) => mm.id))
      for (const id of custom) {
        if (!seen.has(id)) {
          seen.add(id)
          models.push({ id, enabled: !disabled.has(id), custom: true })
        }
      }
      for (const id of disabled) {
        if (seen.has(id)) continue
        seen.add(id)
        models.push({ id, enabled: false })
      }
      const stale = this.modelsCache.get(supplierId)
      // 拉到空列表当「上游抖了一下」:有旧值就保住旧值并返回它,别把面板清空。
      // 真的一家模型都没有的供应商,第一次(无旧值)就该拿到空,不受影响。
      if (models.length === 0 && stale !== undefined && stale.models.length > 0) {
        return stale.models
      }
      this.modelsCache.set(supplierId, { models, fetchedAt: Date.now() })
      return models
    })()
      .catch((err: unknown) => {
        const stale = this.modelsCache.get(supplierId)
        if (stale !== undefined) return stale.models
        throw err instanceof Error ? err : new Error(String(err))
      })
      .finally(() => {
        this.modelsInflight.delete(supplierId)
      })
    this.modelsInflight.set(supplierId, p)
    return p
  }

  /** 失效某供应商的模型缓存（增删改模型后调用）。 */
  invalidateModels(supplierId: string): void {
    this.modelsCache.delete(supplierId)
  }

  /** 可用模型（按供应商分组，仅启用），面板加模型用。
   *  各供应商**并行**拉取——串行会把每个上游的延迟累加起来。 */
  async supplierModels(): Promise<Array<{ supplier: { id: string; name: string; alias: string }; models: ModelWithEnabled[] }>> {
    const groups = await Promise.all(this.active.map(async (s) => {
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
        const s = this.active.find((x) => x.getAlias() === alias)
        return s === undefined ? modelId : `${s.id},${modelId}`
      })
  }

  /** 创建组合（name 唯一，非 default）。选模型是降级链（按序尝试），无策略。 */
  createCombo(name: string, models: string[]): { ok: boolean; error?: string; combo?: Combo } {
    const clean = name.trim()
    if (clean === '' || clean === 'default') return { ok: false, error: '组合名无效' }
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) return { ok: false, error: '组合名只能含字母、数字、-、_ 和 .' }
    if (this.customCombos.some((c) => c.name === clean)) return { ok: false, error: `组合 ${clean} 已存在` }
    if (!this.validModels(models)) return { ok: false, error: '至少需要一个模型' }
    const combo: Combo = { id: clean, name: clean, models: this.normalizeModelIds(models) }
    this.customCombos.push(combo)
    this.saveCombos()
    return { ok: true, combo }
  }

  /** 更新组合（按 id）。 */
  updateCombo(id: string, name: string, models: string[]): { ok: boolean; error?: string } {
    const target = this.customCombos.find((c) => c.id === id)
    if (!target) return { ok: false, error: '组合不存在' }
    const clean = name.trim()
    if (clean === '' || clean === 'default') return { ok: false, error: '组合名无效' }
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) return { ok: false, error: '组合名只能含字母、数字、-、_ 和 .' }
    if (this.customCombos.some((c) => c.id !== id && c.name === clean)) return { ok: false, error: `组合 ${clean} 已存在` }
    if (!this.validModels(models)) return { ok: false, error: '至少需要一个模型' }
    target.name = clean
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
    // 每个客户端请求一条用量记录（组合回退会试多个供应商，但只落一次账）
    const probe: UsageProbe = {
      requested: req.model,
      supplier: '',
      model: '',
      uid: '',
      tokens: null,
      outputChars: 0,
      ttfbMs: 0,
      startedAt: Date.now(),
    }
    const settle = (ok: boolean, error?: string): void => {
      // 估算只在**请求真被服务**时才有意义：失败请求一个字节都没到上游
      // （或上游直接拒了），拿请求体字符数给它编造输入 token 只会把
      // token 总量灌水。成功但上游没发 usage 才走估算。
      const usage = ok
        ? withEstimates(probe.tokens, req.rawBody.length, probe.outputChars)
        : { promptTokens: 0, completionTokens: 0, cachedTokens: 0, inputEstimated: false, outputEstimated: false }
      this.usage.record({
        supplier: probe.supplier,
        model: probe.model,
        requested: probe.requested,
        ok,
        durationMs: Date.now() - probe.startedAt,
        ttfbMs: probe.ttfbMs,
        // 只有真被服务过才记 uid：失败请求的 uid 可能是空或上一次的残留
        ...(ok && probe.uid !== '' ? { uid: probe.uid } : {}),
        ...(req.session === undefined ? {} : { session: req.session }),
        ...(error === undefined ? {} : { error }),
      }, usage)
    }

    const combo = this.comboByName(req.model)
    if (combo) {
      // 组合 = 降级链：从第一个模型起顺序尝试，谁先服务成功就停。
      for (let i = 0; i < combo.models.length; i++) {
        const model = combo.models[i]
        if (model === undefined) continue
        const trace: ChatTrace = { attempts: 0 }
        // 每条腿**独立**一份首字节预算：上一条腿已经等满 60s 也不该让下一条腿
        // 只剩 0ms（否则组合越多越没法用），但同一条腿内的多个号共享一份
        // （停滞是上游级的，按号各等一份会 11×60s）。
        const served = await this.chatWithModel(
          req, res, model, probe, trace, Date.now() + this.firstByteBudgetMs,
        )
        if (served) {
          settle(true)
          return
        }
        // 瞬时故障：先给上游一个恢复窗口再换下一个模型。否则过载的上游
        // 会被整个组合在几毫秒内依次打穿 —— 最后一次失败就是全灭 503。
        if (trace.lastState !== undefined && isTransient(trace.lastState) && i < combo.models.length - 1) {
          await new Promise((r) => setTimeout(r, TRANSIENT_SETTLE_MS))
        }
      }
      settle(false, 'combo: all models unavailable')
      writeJson(res, 503, openAIError('no_healthy_supplier', `combo ${JSON.stringify(req.model)}: all models unavailable`))
      return
    }
    // 直接调用：模型全名 = alias/model。用别名反查供应商，精准调用。
    // 查不到别名（无 `alias/` 前缀）就走 chatWithModel，那里会要求
    // `supplierId,modelId` 形态；两者都不满足 = 缺供应商前缀 → 直接 503，
    // 不再遍历所有供应商兜底（严格图6拓扑）。
    const slash = req.model.indexOf('/')
    const alias = slash > 0 ? req.model.slice(0, slash) : ''
    const target = alias === '' ? undefined : this.supplierByAlias(alias)
    if (target !== undefined) {
      const served = await this.chatWithTarget(target, req, res, probe)
      if (served) {
        settle(true)
        return
      }
      settle(false, `supplier ${target.id}: all accounts unavailable`)
      writeJson(res, 503, openAIError('no_healthy_supplier', `supplier ${JSON.stringify(target.id)}: all accounts unavailable`))
      return
    }
    const served = await this.chatWithModel(req, res, req.model, probe)
    if (served) {
      settle(true)
      return
    }
    settle(false, 'all suppliers unavailable')
    writeJson(res, 503, openAIError('no_healthy_supplier', 'all suppliers unavailable'))
  }

  /** 调指定供应商。
   *  模型名**原样**传给插件（不在这剥 alias/）——插件自己认得自己的别名
   *  （如 traework 会剥第一段）。核心在这剥就会剥两次，把模型 id 里的
   *  命名空间（如 org/name）吃掉。 */
  private async chatWithTarget(s: Supplier, req: ChatRequest, res: ServerResponse, probe?: UsageProbe): Promise<boolean> {
    return await this.chatWithModel(req, res, `${s.id},${req.model}`, probe)
  }

  /** 把 model 改写为组合选中的模型名后，找对应的供应商 + 账号（策略全在核心）。
   *
   *  `model` 形如 `supplierId,modelId`（组合的存储格式）：直接用 supplierId 定位，
   *  不再挨个问供应商「这是不是你的模型」——精准调用，也避免同名模型串台。
   *  兼容旧的裸 `modelId`（没有逗号）：降级为遍历，行为同以前。
   */
  /**
   * @param outTrace 可选出参：把这次调用的追踪信息带回去（组合据此判断
   *   要不要「喘口气」再降级）。裸 id 遍历路径不填（多供应商混在一起，
   *   失败状态没有单一归属）。
   * @param firstByteDeadlineAt 这条腿的首字节截止时刻（绝对 ms）。同一条腿内的
   *   多个账号共享它——停滞是上游级的，按号各给一份会 11×60s 才轮到下一个模型。
   *   缺省 = 此刻起一份全新预算（直接调用路径只有这一条腿）。
   */
  private async chatWithModel(
    req: ChatRequest,
    res: ServerResponse,
    model: string,
    probe?: UsageProbe,
    outTrace?: ChatTrace,
    firstByteDeadlineAt = Date.now() + this.firstByteBudgetMs,
  ): Promise<boolean> {
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

    // 图6 严格拓扑：组合/路由里的每个模型都必须带 `supplierId,modelId` 前缀。
    // 无逗号 = 配置缺供应商前缀（旧版裸 id 遗留），不再遍历所有供应商兜底——
    // 遍历会让拼错的/缺前缀的模型静默落到某个供应商上，更难查。直接判失败。
    if (supplierId === undefined) {
      const msg = `model ${JSON.stringify(model)} 缺供应商前缀（应为 supplierId,modelId）`
      this.logChat(req.model, msg, 0)
      return false
    }
    // 精准：只调这一个供应商。查不到就是配置错了，直接失败（不遍历兜底）
    const s = this.active.find((x) => x.id === supplierId)
    if (s === undefined) {
      // 「被开关关掉」与「不存在」对请求是同一件事：都没有可用的上游。分开说
      // 是为了日志能直接看出是用户关了它。
      const reason = this.suppliers.some((x) => x.id === supplierId)
        ? `supplier ${JSON.stringify(supplierId)} 已关闭`
        : `supplier ${JSON.stringify(supplierId)} 不存在`
      this.logChat(req.model, reason, 0)
      return false
    }
    const t0 = Date.now()
    const trace: ChatTrace = { attempts: 0 }
    const served = await this.chatWithSupplier(s, clone, res, trace, probe, firstByteDeadlineAt)
    if (outTrace !== undefined) {
      outTrace.attempts = trace.attempts
      outTrace.lastError = trace.lastError
      outTrace.lastState = trace.lastState
    }
    this.logChat(req.model, served
      ? `${s.id}/${modelId} (${trace.uid ?? '?'}) ok${trace.attempts > 0 ? ` 重试${trace.attempts}次` : ''}${trace.pickWhy !== undefined ? ` [选号: ${trace.pickWhy}]` : ''}`
      : `${s.id}/${modelId} 失败 ${trace.lastError ?? 'no account'}`, Date.now() - t0)
    return served
  }

  /** 按别名找供应商（对外模型全名 = alias/model）。别名唯一，故最多命中一个。 */
  supplierByAlias(alias: string): Supplier | undefined {
    return this.active.find((s) => s.getAlias() === alias)
  }

  /**
   * 单个供应商内遍历账号（核心策略）：选号 → 调 chatOnce → 按返回的
   * AccountState 处置 → 失败换号；写响应只在成功后发生。
   *
   * 流式**推迟到第一个字节才写响应头**，所以「上游刚连上就断」这种情况
   * 还能换号重试；一旦写出第一个字节就绑死（HTTP 语义，9router 同样如此），
   * 之后出错不再换号——要彻底能回退就得在写头前缓冲判定，代价是首字节
   * 延迟，目前未做。
   *
   * @param firstByteDeadlineAt 这条腿的首字节截止时刻（见 chatWithModel）。
   *   预算耗尽后不再调任何号：剩下的号大概率同样停滞（上游级故障），
   *   挨个等下去只会把 60s 乘以号数，组合永远轮不到下一个模型。
   */
  /**
   * @param onlyUid - 只试这一个连接，**不做账号池回退**。给面板「指定连接」那档用
   *   （诊断单个链接到底通不通）；正常请求与普通模型测试都不传，走账号池。
   */
  private async chatWithSupplier(
    s: Supplier,
    req: ChatRequest,
    res: ServerResponse,
    trace?: ChatTrace,
    probe?: UsageProbe,
    firstByteDeadlineAt = Date.now() + this.firstByteBudgetMs,
    onlyUid?: string,
  ): Promise<boolean> {
    const pool = s.pool
    const cfg = this.store.get(s.id)
    // 无账号供应商：直接调一次（uid 传空，插件忽略）
    if (s.accounts !== undefined && s.accounts().length === 0) {
      const r = await s.chatOnce('', req.lv ?? 'auto', req)
      if (!r.ok) {
        // 模型不属于本供应商、或请求本身被上游拒收：换供应商，不记账
        if (r.state === 'no_such_model' || r.state === 'bad_request') return false
        if (trace !== undefined) trace.lastState = r.state
        pool.noteFailure('', req.model, r.state, r.message)
        return false
      }
      if (trace !== undefined) trace.uid = '(no-account)'
      if (probe !== undefined) {
        probe.supplier = s.id
        // 记对外全名 alias/model：与直接调用路径一致。组合里存的是裸
        // modelId，直接记会把同一个模型在 Top 榜上分裂成两行。
        // 直接调 `alias/model` 时 req.model 已带前缀，先剥掉再拼——
        // 否则会套成 `alias/alias/model`（插件会再剥一次，功能是好的，
        // 只是统计名多一层，Top 榜照样分裂）。
        probe.model = `${s.getAlias()}/${stripAlias(req.model, s.getAlias())}`
        probe.uid = ''
      }
      return await writeChatResult(
        res, r, req.stream, probe, probe?.startedAt ?? 0, firstByteDeadlineAt - Date.now(),
      )
    }
    // 试过的号不再选：某些失败状态既不冷却也不计数（如模型不属于本供应商），
    // 不排除试过的就会原地打转——死循环等于整个服务挂住。
    // messages 只取一次：前缀亲和用它算指纹（重试换号时指纹必须一致，
    // 否则同一会话的两次尝试会绑到不同的号上）。
    const messages = reqMessages(req.rawBody)
    const tried = new Set<string>()
    let pickWhy = ''
    for (;;) {
      // 指定连接：只试它。选不中就直接失败并说明原因（连接已不存在/不在池里），
      // **不回退到别的号** —— 否则「测这个连接」测出来的是另一个号的结果，
      // 诊断就变成了假话。
      const uid = onlyUid !== undefined
        ? (s.accounts().some((a) => a.uid === onlyUid) && !tried.has(onlyUid) ? onlyUid : undefined)
        : pool.pick(s.accounts().filter((a) => !tried.has(a.uid)), cfg.poolOrder, req.model, messages, req.session)
      if (uid === undefined) {
        if (onlyUid !== undefined && trace !== undefined) {
          // 不给 AccountState 加「连接不存在」这个值：那是给**账号的失败**分类用的
          // （决定要不要冷却），而链接不存在不是任何账号的错，混进去会让所有分类逻辑
          // 都要认识它。具体原因放 lastError 就够。
          trace.lastState = 'unknown'
          trace.lastError = `连接 ${JSON.stringify(onlyUid)} 不存在（可能已被删除）`
        }
        return false
      }
      // 腿的首字节预算已经耗尽：不再调下一个号。停滞是上游级的，剩下那些号
      // 挨个等下去 = 60s × 号数，组合永远轮不到下一个模型（2026-09-24 实测）。
      const left = firstByteDeadlineAt - Date.now()
      if (left <= 0) {
        if (trace !== undefined) {
          trace.lastState = 'transport'
          trace.lastError = 'first-byte budget exhausted'
        }
        return false
      }
      pickWhy = pool.lastWhy
      tried.add(uid)
      const r = await s.chatOnce(uid, req.lv ?? 'auto', req)
      if (!r.ok) {
        // 模型不属于本供应商、或请求本身被上游拒收：整个供应商都跳过，
        // 换号重试没有意义，也不能记在账号头上（否则无关账号会被冷掉）。
        // bad_request（如 tool_call 配对断裂、图片格式不认）对每个号结果相同，
        // 冷号只会把一次「请求有问题」放大成「这个模型谁都别用」。
        if (r.state === 'no_such_model' || r.state === 'bad_request') {
          if (trace !== undefined) {
            trace.lastError = r.state
            trace.lastState = r.state
          }
          return false
        }
        pool.noteFailure(uid, req.model, r.state, r.message)
        // 故障切走：下次选号会换号，旧块的驻留计数不再适用（前缀归属变了）
        pool.dropBlock(req.model)
        if (trace !== undefined) {
          trace.attempts += 1
          trace.lastState = r.state
          trace.lastError = `${r.state}: ${r.message}`
        }
        continue
      }
      pool.noteSuccess(uid, req.model)
      if (trace !== undefined) {
        trace.uid = uid
        trace.pickWhy = pickWhy
      }
      if (probe !== undefined) {
        probe.supplier = s.id
        // 记对外全名 alias/model：与直接调用路径一致。组合里存的是裸
        // modelId，直接记会把同一个模型在 Top 榜上分裂成两行。
        // 剥一次自己的前缀：直接调 `alias/model` 时 req.model 已带前缀。
        probe.model = `${s.getAlias()}/${stripAlias(req.model, s.getAlias())}`
        probe.uid = uid
      }
      const committed = await writeChatResult(res, r, req.stream, probe, probe?.startedAt ?? 0, firstByteDeadlineAt - Date.now())
      if (committed) {
        // 块轮询反馈：只有成功请求才计入（失败没产生缓存，计入会污染命中率）
        pool.noteCache(uid, req.model, probe?.tokens?.cachedTokens ?? 0, req.session)
        return true
      }
      // 一个字节都没写（上游刚连上就断 / 首字节超时）→ 这个号不算数，换下一个重试
      pool.noteFailure(uid, req.model, 'transport', 'stream failed before first byte')
      if (trace !== undefined) {
        trace.attempts += 1
        trace.lastState = 'transport'
        trace.lastError = 'stream failed before first byte'
      }
    }
  }

  /**
   * 测试某供应商的某模型是否可用。
   *
   * 走真实的账号遍历 + chatOnce 路径：账号池回退/冷却由核心实现，自动生效；
   * 响应丢弃到 sink，限定单一供应商（不跨供应商回退）。
   *
   * @param onlyUid - 限定只测这一个连接（诊断单个链接），**不做账号池回退**。
   *   不传 = 与面板「测试」按钮完全同一条路径（池内任选可用号，失败自动换号）。
   */
  async testModel(supplierId: string, model: string, onlyUid?: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.active.find((x) => x.id === supplierId)
    if (s === undefined) return { ok: false, error: `unknown supplier ${JSON.stringify(supplierId)}` }
    const sink = sinkRes()
    const req: ChatRequest = {
      model,
      stream: false,
      rawBody: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
    }
    let served = false
    const trace: ChatTrace = { attempts: 0 }
    try {
      served = await this.chatWithSupplier(s, req, sink, trace, undefined, Date.now() + this.firstByteBudgetMs, onlyUid)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    // 供应商可能「服务了但写出错误响应」（如 opencode：唯一能处理该模型的供应商，错误自己上报）
    if (served && sink.status() < 400) return { ok: true }
    const fromSink = served && sink.status() >= 400 ? extractUpstreamError(sink.body()) : ''
    // 失败原因优先从上游响应体取，其次用 chatOnce 返回的 message（trace.lastError）。
    // 以前这里问插件的 lastError()——那是「最后一次失败」的可变全局，既可能串到
    // 别的账号/别的请求，也有插件压根没实现（codebuddy 就漏了，于是永远拿不到兜底）。
    // chatOnce 的返回值本身就带 message，用它更准，插件也不必再维护一份状态。
    const detail = fromSink !== '' ? fromSink : trace.lastError
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
    this.usage.flush()
  }
}
