/**
 * DSH llm adapter for dsh-router（provider 固定卡片，名字 Router）。
 *
 * 模型目录 = 组合（自动带出，不可改）。对话转发到本插件 /v1/chat/completions，
 * 由现有路由按组合策略命中供应商模型。
 *
 * 纯文本流：组合为文本模型，本 adapter 不处理图片附件。
 */
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mergeUsage, normalizeUsage, toTokenUsage, type UsageTokens } from '../router/usage-tokens.ts'

/** 模型目录来源：组合。 */
export interface RouterAdapterSource {
  comboModels: () => Promise<Array<{ id: string; name?: string }>>
}

/**
 * 把 DSH 消息序列化成 openai 兼容 wire 消息（纯文本 + tool）。
 *
 * `system` 必须由调用方从 `options.system` 传进来：agent-loop 把系统提示词
 * 放在 **options.system 这个独立槽位**，不放进 messages（见 dsh-llm
 * types.d.ts 的 `system?: string` —— 注释原话 "adapters map to the
 * provider's system slot"）。不读这个槽位，模型每一轮都拿不到身份/规则/
 * 工具用法约束，且**不会报错**，只是行为悄悄降级。
 */
function wireMessages(options: GenerateOptions, system?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (typeof system === 'string' && system !== '') {
    out.push({ role: 'system', content: system })
  }
  for (const message of options.messages) {
    if (message.role === 'system') {
      // 手写调用也可能把 system 塞进 messages（one-shot 场景），照旧支持
      out.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const toolCalls = message.content
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      const reasoning = message.content
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text)
        .join('')
      out.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      })
      continue
    }
    // user / tool-result
    const text = flattenText(message.content)
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    if (text.length > 0 || toolResults.length === 0) out.push({ role: 'user', content: text })
    for (const result of toolResults) {
      // 空结果就发空串，不要替换成 '(no output)' 之类的字面量 —— 模型会
      // 以为工具真的打印了那句话（9router 也是补 content: ""）。
      out.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) })
    }
  }
  return out
}

/** 组装 wire 请求体。 */
function wireRequest(options: GenerateOptions): Record<string, unknown> {
  const messages = wireMessages(options, options.system)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = options.stop
  applyReasoning(body, options.reasoningEffort)
  return body
}

/**
 * 推理强度 → CodeBuddy 的 OpenAI 风格参数。
 *
 * 照 9router `executors/codebuddy-cn.js` 的处理：CodeBuddy 只有同时收到
 * `reasoning_effort` + `reasoning_summary:"auto"` 才吐推理内容，而 harness
 * 只给 `reasoning_effort`，从不下发 `reasoning_summary`。
 *
 * 关键陷阱（9router 注释里的 #2071）：**不能无条件加**。对没要推理的普通
 * 请求强行加 `reasoning_effort:"medium"` + `reasoning_summary`，会让
 * CodeBuddy 触发内容过滤直接报错。`none`/`off` 也必须是**删字段**而不是传
 * `"none"` —— 网关没有这个值。
 */
function applyReasoning(body: Record<string, unknown>, effort: string | undefined): void {
  if (effort === undefined || effort === '') return
  if (effort === 'none' || effort === 'off') {
    delete body.reasoning_effort
    delete body.reasoning_summary
    return
  }
  body.reasoning_effort = effort
  body.reasoning_summary = 'auto'
}

function flattenText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/** openai SSE payload → DSH StreamChunk 流。导出以便单测锁死 usage 契约。 */
/**
 * 把上游 SSE 的 `data:` 载荷流翻译成 DSH 的 StreamChunk 事件流。
 *
 * 吃 `AsyncIterable`（真流式：边收边吐）或 `Iterable`（测试用数组）。
 * 用 `for await` 是因为它天然兼容两者 —— 不必为流式再写一份。
 */
export async function* translateSse(payloads: AsyncIterable<string> | Iterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: { kind: string; failure?: unknown } | undefined
  /** 攒上游各帧的 usage（归一形态），[DONE] 时统一转成 DSH 契约。 */
  let accumulated: UsageTokens | null = null
  /** 解析失败的帧数（坏帧跳过，不硬抛；全是坏帧才当断流处理）。 */
  let malformed = 0
  /** 有没有产出过任何内容块（content/reasoning/tool-call）。 */
  let produced = false

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    produced = true
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      // 收尾前先筛掉参数没发完的工具调用。
      //
      // 为什么必须筛：上游（CodeBuddy 网关）在长上下文/高压时会在 tool_call
      // 的 arguments **分片没发完**就直接发 `[DONE]`。无条件收尾会把半成品
      // JSON（如 `{"command": "cd`）当完整参数交给 harness，工具侧校验报
      // `missing required property "command"` / `"arguments" must be an object`，
      // 表现为「bash 调用大面积失败」。实测一次会话 29 次工具调用里 27 次
      // 参数残缺。残缺的调用**不能执行**——拿半条命令去跑比报错危险得多。
      const complete = order.filter((block) => block.kind !== 'tool-call' || completeJson(block.text))
      const dropped = order.length - complete.length
      for (const block of complete) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      // 残缺的块**必须补发一个安全的 block-end**，光不发是不够的：
      // dsh-llm 的 BlockAssembler 对缺 block-end 的 index 会用累积的 delta
      // 兜底重建（lib/types/assembler.js），照样组装出 `{"command": "rm -rf /`
      // 这种半成品；而 assembled() 只在 finish.kind === 'max-tokens' 时过滤
      // tool-call —— EMPTY_RESPONSE 的 error finish 不过滤。
      // 补一个空名 + `{}` 的收尾，让它**覆盖**掉 delta 累积值。
      for (const block of order) {
        if (block.kind !== 'tool-call' || completeJson(block.text)) continue
        yield {
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: '', arguments: '{}' },
        }
      }
      if (dropped > 0) {
        // 整轮判 error：让 agent-loop 重试（拿残参执行是错的，静默装作成功更错）
        //
        // code 必须用 EMPTY_RESPONSE：只有 dsh-llm 默认可重试码白名单里的
        // 码才会触发重试（["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT",
        // "TRANSPORT"]，maxRetries 5）。造一个新码（如 INCOMPLETE_TOOL_ARGS）
        // 看着更精确，但不在白名单里 → **一次都不重试**，直接抛给用户，
        // 正好毁掉这里重试的本意。语义也对得上：上游没产出可用的调用。
        pendingFinish = {
          kind: 'error',
          failure: {
            message: `upstream closed the stream before ${dropped} tool call argument${dropped > 1 ? 's were' : ' was'} complete`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      if (accumulated !== null) {
        // 转成 DSH 的 TokenUsage：**必须**转，不能把上游的 OpenAI 形态
        // （prompt_tokens，且含缓存）原样透传。字段名和 DISJOINT 口径都
        // 对不上，下游 token-meter 读到 undefined 会累加出 NaN，投影
        // schema 校验一抛就是整条 session.history 失败（「历史加载失败」）。
        // 转换结果为 null（三个数全 0）则整个省略 usage。见 toTokenUsage。
        const usage = toTokenUsage(accumulated)
        if (usage !== null) yield { type: 'usage', usage }
      }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason:
          reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
            : (reason as never),
      }
      return
    }
    let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>; usage?: unknown }
    try {
      chunk = JSON.parse(payload) as typeof chunk
    } catch {
      // 坏帧**跳过**，不要抛：一帧坏 JSON 毁掉整轮，已流式吐出的内容全废
      // （9router 也是 catch 后继续，见 mitm/handlers/base.js 的
      // "Skip unparseable lines"）。上游断流时最后一帧常常就是半截的，
      // 硬抛等于把可恢复的失败变成必失败 —— 而且 MALFORMED_RESPONSE 不在
      // dsh-llm 的可重试白名单里，抛了也一次都不重试。
      // 真的一帧都没解析成功时，流末按断流处理（见下方）。
      malformed += 1
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const toolCalls = delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined
      for (const call of toolCalls ?? []) {
        const key = call.index ?? 0
        let block = toolBlocks.get(key)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') {
        // 只认真的终止原因：上游（CodeBuddy）会在中间帧发 `finish_reason: ""`，
        // 它是「还没结束」而不是「以空原因结束」。当真原因收进来会被 mapFinishReason
        // 的 default 分支变成 code:"" 的 error finish，agent-loop 拿它重建
        // LlmError 时 dsh-llm 直接抛 `LlmError code must be a non-empty string`
        // —— 界面就是「本轮运行失败 … UNKNOWN」。空的不收，也不许它冲掉真原因。
        const mapped = mapFinishReason(choice.finish_reason)
        if (mapped !== undefined) pendingFinish = mapped
      }
    }
    // 上游可能把 usage 拆在多个帧里（Claude 系：先给输入、后给输出），
    // 所以是字段级 max 合并，不是覆盖。攒着，[DONE] 时统一转契约。
    if (chunk.usage !== undefined) accumulated = mergeUsage(accumulated, normalizeUsage(chunk.usage))
  }
  // 码必须是 TRANSPORT（不是自造的 STREAM_CLOSED / MALFORMED_RESPONSE）：
  // 只有 dsh-llm 默认可重试白名单里的码才会被重试（EMPTY_RESPONSE /
  // RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）。自造码一次都不重试，
  // 断流就直接抛给用户 —— 而断流恰恰是**最该重试**的一类故障。
  const detail = malformed > 0 ? ` (${malformed} frame(s) unparseable)` : ''
  throw new LlmError(`SSE payload stream ended without [DONE]${detail}`, 'TRANSPORT')
}

/** 上游 finish_reason → DSH finish reason；空串（「未终止」）返回 undefined。 */
function mapFinishReason(reason: string): { kind: string; failure?: unknown } | undefined {
  switch (reason) {
    case '': return undefined
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    // 未知原因也要能过 dsh-llm 的 `code` 非空校验：万一上游给的是空白或
    // 纯符号（toUpperCase 后仍可能是怪东西），兜一个稳定码，别把空串交给
    // agent-loop —— 它拿 code 重建 LlmError，空码 = 抛「本轮运行失败」。
    default: {
      const code = reason.trim().toUpperCase()
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: code === '' ? 'UNKNOWN_FINISH_REASON' : code },
      }
    }
  }
}

function closeBlock(block: OpenBlock): never {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text } as never
    case 'reasoning': return { type: 'reasoning', text: block.text } as never
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      // 空串 = 无参工具，合法（上游很多工具不吃参数）；补成 `{}` 让下游
      // 不必分支。能走到这里的必然是完整 JSON（残缺的已在 [DONE] 处拦掉）。
      arguments: block.text === '' ? '{}' : block.text,
    } as never
  }
}

/**
 * 工具调用的 arguments 是否已经收完整（能解析成一个 JSON 对象）。
 *
 * 判断口径刻意简单：只看能不能 `JSON.parse` 出对象。不校验 schema——
 * 那是工具自己的活，adapter 只负责「别把半成品交出去」。
 * 空串视为完整（无参工具），因为上游不发参数分片是合法的。
 */
function completeJson(text: string): boolean {
  if (text.trim() === '') return true
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false // 分片没发完，JSON 必然解析失败
  }
}

/**
 * DSH adapter：provider `router`。模型目录 = 组合；stream 转发到本插件
 * /v1/chat/completions（组合路由在 /v1 内完成）。
 */
/** Router provider 对外暴露的推理等级（对齐 dsh/DeepSeek：off/low/high/max）。 */
const ROUTER_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId('off'), name: 'Off' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('max'), name: 'Max' },
]

export class RouterAdapter extends LlmAdapter {
  private readonly baseURL: string
  private readonly source: RouterAdapterSource

  constructor(baseURL: string, source: RouterAdapterSource) {
    super()
    this.baseURL = baseURL
    this.source = source
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Router' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const combos = await this.source.comboModels()
    const seen = new Set<string>()
    const out: LlmModelInfo[] = []
    for (const m of combos) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ provider: 'router', id: m.id, name: m.name ?? m.id })
    }
    return out
  }

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const combos = await this.source.comboModels()
    const found = combos.find((m) => m.id === model || m.name === model)
    const name = found?.name ?? found?.id ?? model
    // 组合背后是异构供应商，统一声明 dsh 推理等级；实际能否生效取决于
    // 命中的上游（供应商各有各自的映射/忽略规则，见 applyReasoning + chatOnce(lv)）。
    // 默认 High：调用方不指定 effort 时，runtime 会物化为 'high' 下发。
    return {
      provider: 'router',
      id: model,
      name,
      reasoning: { efforts: ROUTER_REASONING_EFFORTS, defaultEffort: ReasoningEffortId('high') },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = wireRequest(options)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let resp: Response
    try {
      resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        // attributionHeaders() 是 dsh-llm 对 adapter 的硬契约：每个 provider
        // 请求都必须带（LlmAdapter 类注释原话）。它给出
        // `user-agent: deepseek-harness/<ver> (+url)`。
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new LlmError(`dsh-router upstream call failed: ${(error as Error).message}`, 'TRANSPORT', { cause: error })
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new LlmError(`dsh-router /v1 returned ${resp.status}: ${detail.slice(0, 200)}`, 'TRANSPORT')
    }
    if (resp.body === null) return
    yield* translateSse(ssePayloads(resp.body))
  }
}

/**
 * 已攒的 payload 是否已经是完整的（`[DONE]` 或一个能解析的 JSON 对象）。
 *
 * 只用于「缺空行分隔」时的前瞻回退，不校验业务结构 —— 那是 translateSse 的事。
 */
function looksComplete(payload: string): boolean {
  if (payload === '[DONE]') return true
  try {
    JSON.parse(payload)
    return true
  } catch {
    return false
  }
}

/**
 * 从上游响应体**增量**产出 SSE 的 `data:` 载荷。
 *
 * 为什么必须逐块读：曾经这里写 `await resp.text()` 攒完整串再解析，等于
 * 把流式降级成批处理 —— 首字节延迟等于整个响应耗时；更糟的是中途断流时
 * resp.text() 只拿到半截文本，最后一帧是半截 JSON（`{"command": "cd`），
 * 表现为「工具参数残缺」。短响应连接不断，所以本地抓包复现不了。
 *
 * 跨块边界：一个 `data:` 行可能横跨两次 read()，所以留 `buffer` 接住
 * 最后一段未完整的行（9router 的 pipeTransformedSSE 同样处理）。
 */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''
  /** 攒一帧内的多行 data（SSE 规范：多行用 \n 连起来）。**必须**是局部
   *  状态 —— 放模块级会让并发请求互相串数据。 */
  let payload = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一段可能没换行，留给下一块
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('data:')) {
          // 前瞻回退：部分上游不发空行分隔，直接连着发下一帧。这时若已攒的
          // payload 本身是个完整 JSON，就先把它交出去 —— 否则两帧会被拼成
          // `{...}\n{...}` 而 parse 失败，整轮报废（9router 逐行取，天然
          // 没这问题；我们按空行分帧，就得补这个回退）。
          if (payload.length > 0 && looksComplete(payload)) {
            yield payload
            payload = ''
          }
          payload += (payload.length > 0 ? '\n' : '') + t.slice(5).trimStart()
          continue
        }
        // 空行 = 一帧结束
        if (t === '' && payload.length > 0) {
          yield payload
          payload = ''
        }
      }
    }
    // 流正常结束：末尾没换行的内容也要收（可能有最后一帧）
    if (buffer.length > 0) {
      const t = buffer.trim()
      if (t.startsWith('data:')) payload += (payload.length > 0 ? '\n' : '') + t.slice(5).trimStart()
    }
    if (payload.length > 0) yield payload
  } finally {
    // 释放锁**之后还必须 cancel**：releaseLock() 只解除 JS 侧的 reader 绑定，
    // 不通知传输层 —— 上游那条 TCP 连接和 in-flight 请求会原样挂着。
    // dsh-llm 在消费者提前退出时必走 `iterator.return()`（用户取消 /
    // agent-loop 收敛 / 异常），于是每次中断泄漏一条到本地路由器的连接；
    // 长会话下 fd 耗尽 → ECONNRESET / 端口耗尽。
    // 顺序不能反：cancel() 要求没有活跃 reader，所以先 releaseLock。
    try { reader.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
    await body.cancel().catch(() => {})
  }
}
