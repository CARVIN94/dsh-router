/**
 * DSH llm adapter for dsh-router（provider 固定卡片，名字 Router）。
 *
 * 模型目录 = 组合（自动带出，不可改）。对话转发到本插件 /v1/chat/completions，
 * 由现有路由按组合策略命中供应商模型。
 *
 * 纯文本流：组合为文本模型，本 adapter 不处理图片附件。
 */
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mergeUsage, normalizeUsage, toTokenUsage, type UsageTokens } from '../router/usage-tokens.ts'

/** 模型目录来源：组合。 */
export interface RouterAdapterSource {
  comboModels: () => Promise<Array<{ id: string; name?: string }>>
}

/** 解析 SSE 文本，产出 `data:` 载荷（含结尾 [DONE]）。 */
function* parseSseText(text: string): Generator<string> {
  let data = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const value = line.slice(5).trimStart()
      if (data.length > 0) data += '\n'
      data += value
      continue
    }
    if (line === '' && data.length > 0) {
      yield data
      data = ''
    }
  }
  if (data.length > 0) yield data
}

/** 把 DSH 消息序列化成 openai 兼容 wire 消息（纯文本 + tool）。 */
function wireMessages(options: GenerateOptions): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const message of options.messages) {
    if (message.role === 'system') {
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
      out.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
  }
  return out
}

/** 组装 wire 请求体。 */
function wireRequest(options: GenerateOptions): Record<string, unknown> {
  const messages = wireMessages(options)
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
  return body
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
export async function* translateSse(payloads: Iterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: { kind: string; failure?: unknown } | undefined
  /** 攒上游各帧的 usage（归一形态），[DONE] 时统一转成 DSH 契约。 */
  let accumulated: UsageTokens | null = null

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for (const payload of payloads) {
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
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
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
          id: CallId(block.callId ?? ''),
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
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
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
      id: CallId(block.callId ?? ''),
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = wireRequest(options)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let resp: Response
    try {
      resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
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
    const text = resp.body === null ? '' : await resp.text()
    yield* translateSse(parseSseText(text))
  }
}
