/**
 * DSH llm adapter for dsh-router（provider 固定卡片，名字 Router）。
 *
 * 模型目录 = 组合（自动带出，不可改）。对话转发到本插件 /v1/chat/completions，
 * 由现有路由按组合策略命中 traework 模型。
 *
 * 纯文本流：traework 组合是文本模型，本 adapter 不处理图片附件。
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

/** openai SSE payload → DSH StreamChunk 流。 */
async function* translate(payloads: Iterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: { kind: string; failure?: unknown } | undefined
  let pendingUsage: unknown

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage as never }
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
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage !== undefined) pendingUsage = chunk.usage
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

function mapFinishReason(reason: string): { kind: string; failure?: unknown } {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
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
      arguments: block.text,
    } as never
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
    yield* translate(parseSseText(text))
  }
}
