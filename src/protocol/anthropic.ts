/**
 * Anthropic Messages 协议。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么第一个做它
 * ════════════════════════════════════════════════════════════════════
 * Claude Code 只会说这一种协议，而它对 `ANTHROPIC_BASE_URL` 的支持是现成的：
 * 把它指到我们的端点，就**直接**能用上账号池/组合/用量看板。其余三种协议
 * （Responses/Gemini）没有这样的「一个客户端在等」的理由。
 *
 * ════════════════════════════════════════════════════════════════════
 * 翻译表（唯一的事实来源）
 * ════════════════════════════════════════════════════════════════════
 *  请求  system            → messages[0] 的 system-role 消息（字符串或块数组都要吃）
 *        tools[].input_schema → tools[].function.parameters
 *        tool_use / tool_result 块 → assistant.tool_calls / role:"tool"
 *        max_tokens / temperature / stop_sequences → 同名（下划线差异两处）
 *  响应  message_start     → usage（input_tokens 在这帧）
 *        content_block_start(text)     → text 增量开始
 *        content_block_delta(text_delta) → text 增量
 *        content_block_delta(input_json_delta) → tool-args 增量
 *        content_block_delta(thinking_delta) → reasoning 增量
 *        content_block_stop  → 该 index 结束（无对应规范事件，吃掉）
 *        message_delta      → usage + finish_reason
 *        message_stop       → 无对应事件（finish 已由 message_delta 给）
 *
 * 丢弃（明确不做翻译，见下）：
 *   - `cache_control`：Anthropic 的提示缓存标记。跨到 Chat 后失去意义
 *     （Chat 的缓存是上游自动的），硬造一个 `prompt_cache_key` 反而是猜。
 *   - `thinking.budget_tokens`：只在响应侧保留为 reasoning 增量。
 *   - `mcp_servers` / `container` / `context_management`：客户端侧特性，
 *     转发到只懂 Chat 的上游只会得到 400。
 */
import {
  type ChatEvent,
  type CodecContext,
  type FinishReason,
  type JsonObject,
  type ProtocolCodec,
  arr,
  finishOf,
  num,
  obj,
  str,
} from './types.ts'
import { dataFrame, eventFrame } from './sse.ts'

/* ------------------------------------------------------------------ */
/* 请求侧                                                             */
/* ------------------------------------------------------------------ */

export const anthropicCodec: ProtocolCodec = {
  id: 'anthropic',

  /** Anthropic 请求 → Chat Completions 请求。 */
  toChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.system
    delete out.tools
    delete out.max_tokens
    delete out.stop_sequences

    const messages: unknown[] = []
    const system = body.system
    if (system !== undefined) {
      const text = systemText(system)
      if (text !== '') messages.push({ role: 'system', content: text })
    }
    for (const m of messagePairs(body.messages)) messages.push(m)

    out.messages = messages
    if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens
    if (body.stop_sequences !== undefined) out.stop = body.stop_sequences
    if (body.temperature !== undefined) out.temperature = body.temperature
    if (body.top_p !== undefined) out.top_p = body.top_p
    const tools = convertTools(body.tools)
    if (tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /** Chat Completions 请求 → Anthropic 请求（供应商说 Anthropic 时用）。 */
  fromChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.messages
    delete out.tools
    delete out.stop
    delete out.stream

    const systemParts: string[] = []
    const messages: unknown[] = []
    for (const m of body.messages as unknown[]) {
      const msg = obj(m)
      if (msg === undefined) continue
      const role = str(msg.role)
      if (role === 'system') {
        const t = contentText(msg.content)
        if (t !== '') systemParts.push(t)
        continue
      }
      if (role === 'assistant') {
        messages.push(assistantMessage(msg))
        continue
      }
      if (role === 'tool') {
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: str(msg.tool_call_id) ?? '',
            content: contentText(msg.content),
          }],
        })
        continue
      }
      messages.push({ role: 'user', content: contentText(msg.content) })
    }

    if (systemParts.length > 0) out.system = systemParts.join('\n\n')
    out.messages = messages
    // max_tokens 在 Anthropic 侧必填，而 Chat 侧可有可无 —— 缺省给一个值，
    // 否则 Anthropic 上游会直接 400「max_tokens is required」
    out.max_tokens = num(body.max_tokens) ?? 4096
    if (body.stop !== undefined) out.stop_sequences = body.stop
    const tools = (body.tools as unknown[] | undefined)?.map(chatToolToAnthropic).filter((t) => t !== undefined)
    if (tools !== undefined && tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /* ---------------- 响应侧：Anthropic SSE → ChatEvent ---------------- */

  decodeFrame(frame, event) {
    let payload: JsonObject
    try {
      payload = JSON.parse(frame) as JsonObject
    } catch {
      return []
    }
    switch (event) {
      case 'message_start':
        return messageStartEvents(payload)
      case 'content_block_start':
        return contentBlockStartEvents(payload)
      case 'content_block_delta':
        return contentDeltaEvents(payload)
      case 'message_delta':
        return messageDeltaEvents(payload)
      case 'error':
        return [{ type: 'error', message: str(obj(payload.error)?.message) ?? 'upstream error' }]
      // content_block_start / content_block_stop / ping / message_stop /
      // message_delta 之外的：没有对应规范事件
      default:
        return []
    }
  },

  /* ---------------- 响应侧：ChatEvent → Anthropic SSE ---------------- */

  encodeFrame(event) {
    switch (event.type) {
      case 'text':
        return [
          eventFrame(
            'content_block_delta',
            JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: event.text },
            }),
          ),
        ]
      case 'reasoning':
        return [
          eventFrame(
            'content_block_delta',
            JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: event.text },
            }),
          ),
        ]
      case 'tool-start':
        return [
          eventFrame(
            'content_block_start',
            JSON.stringify({
              type: 'content_block_start',
              index: event.index,
              content_block: {
                type: 'tool_use',
                id: event.id ?? `toolu_${event.index}`,
                name: event.name ?? '',
                input: {},
              },
            }),
          ),
        ]
      case 'tool-args':
        return [
          eventFrame(
            'content_block_delta',
            JSON.stringify({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'input_json_delta', partial_json: event.delta },
            }),
          ),
        ]
      case 'usage':
        // 只带 output_tokens：Anthropic 的 message_delta 语义如此（输入用量在
        // message_start 那帧）。这里多发一个 input_tokens 会被部分客户端当成
        // 覆盖值处理，反而把真实输入用量冲掉。
        return [
          eventFrame(
            'message_delta',
            JSON.stringify({
              type: 'message_delta',
              delta: {},
              usage: { output_tokens: event.completionTokens },
            }),
          ),
        ]
      case 'error':
        return [
          eventFrame(
            'error',
            JSON.stringify({ type: 'error', error: { type: 'api_error', message: event.message } }),
          ),
        ]
      case 'finish':
        // 只发 message_delta(stop_reason)。`message_stop` 由 `endFrames` 发 ——
        // 两处都发会在流尾出现两个 message_stop，Anthropic 客户端会把后一个
        // 当成新的一轮开始。
        return [
          eventFrame(
            'message_delta',
            JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: finishToAnthropic(event.reason), stop_sequence: null },
              usage: { output_tokens: 0 },
            }),
          ),
        ]
    }
  },

  startFrames(ctx) {
    return [
      eventFrame(
        'message_start',
        JSON.stringify({
          type: 'message_start',
          message: {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: ctx.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      ),
    ]
  },

  endFrames() {
    return [eventFrame('message_stop', JSON.stringify({ type: 'message_stop' }))]
  },

  /**
   * 非流式响应体 → 规范事件。
   *
   * Anthropic 非流式 body 形状：`{content:[{type:'text',text}|{type:'tool_use',...}],
   * stop_reason, usage:{input_tokens,output_tokens,cache_read_input_tokens}}`。
   * 与流式共用同一组 block→事件 的映射，见 `blockEvents`。
   */
  decodeJson(body) {
    const out: ChatEvent[] = []
    let index = 0
    let text = ''
    for (const b of arr(body.content) ?? []) {
      const block = obj(b)
      if (block === undefined) continue
      if (block.type === 'text') {
        const t = str(block.text)
        if (t !== undefined) { text += t; index += 1 }
        continue
      }
      if (block.type === 'thinking') {
        const t = str(block.thinking)
        if (t !== undefined) { out.push({ type: 'reasoning', text: t }); index += 1 }
        continue
      }
      if (block.type === 'tool_use') {
        out.push({ type: 'tool-start', index, ...(str(block.id) === undefined ? {} : { id: str(block.id) }), name: str(block.name) ?? '' })
        out.push({ type: 'tool-args', index, delta: JSON.stringify(block.input ?? {}) })
        index += 1
      }
    }
    if (text !== '') out.unshift({ type: 'text', text })
    const usage = obj(body.usage)
    if (usage !== undefined) {
      out.push({
        type: 'usage',
        promptTokens: num(usage.input_tokens) ?? 0,
        completionTokens: num(usage.output_tokens) ?? 0,
        cachedTokens: num(usage.cache_read_input_tokens) ?? 0,
      })
    }
    const stop = body.stop_reason
    if (stop !== undefined && stop !== null) {
      out.push({ type: 'finish', reason: finishOf(stop === 'max_tokens' ? 'length' : stop) })
    }
    return out
  },

  /** 规范事件 → 非流式 body。 */
  encodeJson(events, ctx) {
    const content: JsonObject[] = []
    let stop = 'end_turn'
    let usage = { input: 0, output: 0, cached: 0 }
    for (const ev of events) {
      switch (ev.type) {
        case 'text':
          // 连续 text 事件合成一个块（非流式没有「增量」概念，拆成多个块
          // 会让客户端渲染出多个段落）
          if (content.length > 0 && content[content.length - 1]?.type === 'text') {
            ;(content[content.length - 1] as JsonObject).text += ev.text
          } else {
            content.push({ type: 'text', text: ev.text })
          }
          break
        case 'reasoning':
          if (content.length > 0 && content[content.length - 1]?.type === 'thinking') {
            ;(content[content.length - 1] as JsonObject).thinking += ev.text
          } else {
            content.push({ type: 'thinking', thinking: ev.text })
          }
          break
        case 'tool-start':
          content.push({ type: 'tool_use', id: ev.id ?? `toolu_${ev.index}`, name: ev.name ?? '', input: {} })
          break
        case 'tool-args': {
          const last = content[content.length - 1]
          if (last?.type === 'tool_use') {
            // 参数增量可能是多段：拼起来再解析（半截 JSON 用空对象兜底）
            const prev = str(last.input) ?? ''
            last.input = parseArgs(prev + ev.delta)
          }
          break
        }
        case 'finish': stop = finishToAnthropic(ev.reason); break
        case 'usage': usage = { input: ev.promptTokens, output: ev.completionTokens, cached: ev.cachedTokens }; break
        case 'error': break
      }
    }
    return {
      id: `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      content,
      model: ctx.model,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(usage.cached > 0 ? { cache_read_input_tokens: usage.cached } : {}),
      },
    }
  },
}

/* ------------------------------------------------------------------ */
/* 请求侧实现                                                         */
/* ------------------------------------------------------------------ */

/** Anthropic 的 system 字段：字符串或 [{type:'text',text}] 数组。 */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  const parts: string[] = []
  for (const b of arr(system) ?? []) {
    const t = str(obj(b)?.text)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/**
 * Anthropic messages → Chat messages。
 *
 * 关键差异：Anthropic 把「模型发起的工具调用」与「用户回传的工具结果」都放在
 * content 块里，而 Chat 把它们拆成 `assistant.tool_calls` 与 `role:'tool'` 消息。
 * 且 Anthropic 允许 tool_result 单独成一条 user 消息，Chat 也允许 —— 但**连续
 * 多条 tool_result 必须各自一条**，合并不了（每个 tool_use_id 要能对上）。
 */
function messagePairs(messages: unknown): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = []
  for (const m of arr(messages) ?? []) {
    const msg = obj(m)
    if (msg === undefined) continue
    const role = str(msg.role)
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = arr(msg.content)
    // 纯文本消息：走快路径，别为它造块
    if (blocks === undefined) {
      out.push({ role, content: typeof msg.content === 'string' ? msg.content : '' })
      continue
    }
    const texts: string[] = []
    const toolCalls: JsonObject[] = []
    const toolResults: JsonObject[] = []
    for (const b of blocks) {
      const block = obj(b)
      if (block === undefined) continue
      switch (block.type) {
        case 'text': {
          const t = str(block.text)
          if (t !== undefined) texts.push(t)
          break
        }
        case 'tool_use':
          toolCalls.push({
            id: str(block.id) ?? '',
            type: 'function',
            function: {
              name: str(block.name) ?? '',
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
          break
        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: str(block.tool_use_id) ?? '',
            content: blockContentText(block.content),
          })
          break
        // image / document / thinking：跨协议没有对应物，丢弃
        default:
          break
      }
    }
    // 一条 Anthropic 消息可能同时带文本与工具调用（Chat 也允许：content + tool_calls）
    if (role === 'assistant') {
      const msg2: JsonObject = { role: 'assistant', content: texts.join('\n\n') }
      if (toolCalls.length > 0) msg2.tool_calls = toolCalls
      out.push(msg2 as { role: string; content: unknown })
    } else {
      // user：文本与工具结果都是 user 侧内容。Chat 侧 tool 结果必须是独立消息，
      // 所以拆成「一条带文本的 user」+「每条 tool」。
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') })
      for (const tr of toolResults) out.push(tr as { role: string; content: unknown })
    }
  }
  return out
}

/** tool_result 的 content：字符串或 [{type:'text'}] 数组。 */
function blockContentText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const b of arr(content) ?? []) {
    const t = str(obj(b)?.text)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Chat 的 content（字符串或 parts 数组）→ 纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of arr(content) ?? []) {
    const part = obj(p)
    if (part === undefined) continue
    const t = str(part.text) ?? str(part.content)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Chat assistant 消息 → Anthropic assistant 消息（tool_calls → tool_use 块）。 */
function assistantMessage(msg: JsonObject): JsonObject {
  const content: JsonObject[] = []
  const text = contentText(msg.content)
  if (text !== '') content.push({ type: 'text', text })
  for (const tc of arr(msg.tool_calls) ?? []) {
    const call = obj(tc)
    if (call === undefined) continue
    const fn = obj(call.function)
    content.push({
      type: 'tool_use',
      id: str(call.id) ?? '',
      name: str(fn?.name) ?? '',
      input: parseArgs(str(fn?.arguments)),
    })
  }
  return { role: 'assistant', content }
}

/** 解析工具参数字符串；坏 JSON 返回空对象（上游偶发半截参数，别让整条消息失败）。 */
function parseArgs(s: string | undefined): JsonObject {
  if (s === undefined || s === '') return {}
  try {
    const v: unknown = JSON.parse(s)
    return obj(v) ?? {}
  } catch {
    return {}
  }
}

/** Chat tools → Anthropic tools（`function.parameters` → `input_schema`）。 */
function convertTools(tools: unknown): JsonObject[] {
  const out: JsonObject[] = []
  for (const t of arr(tools) ?? []) {
    const tool = obj(t)
    if (tool === undefined) continue
    const fn = obj(tool.function)
    if (fn === undefined) continue
    const name = str(fn.name)
    if (name === undefined) continue
    out.push({
      name,
      description: str(fn.description) ?? '',
      input_schema: obj(fn.parameters) ?? { type: 'object', properties: {} },
    })
  }
  return out
}

/**
 * Chat tool → Anthropic tool（`fromChat` 方向，与上面的 `convertTools` 反着走）。
 *
 * Chat 的具名工具是 `{ type:'function', function:{ name, description, parameters } }`
 * —— **多包了一层** `function`。直接读 `tool.name` 会永远 undefined，于是所有
 * 工具被静默丢掉（Claude Code 接上来就看不到任何 tool）。所以这里先解包，
 * 再兼容已经扁平化的输入（有些中间层会提前拍平）。
 */
function chatToolToAnthropic(t: unknown): JsonObject | undefined {
  const tool = obj(t)
  if (tool === undefined) return undefined
  const fn = obj(tool.function) ?? tool
  const name = str(fn.name)
  if (name === undefined) return undefined
  return {
    name,
    description: str(fn.description) ?? '',
    input_schema: obj(fn.parameters) ?? { type: 'object', properties: {} },
  }
}

/* ------------------------------------------------------------------ */
/* 响应侧实现                                                         */
/* ------------------------------------------------------------------ */

/** message_start：把 input_tokens 带出来（Anthropic 只在这帧给输入用量）。 */
function messageStartEvents(payload: JsonObject): ChatEvent[] {
  const usage = obj(obj(payload.message)?.usage)
  const input = num(usage?.input_tokens) ?? 0
  const cached = num(usage?.cache_read_input_tokens) ?? 0
  return [{ type: 'usage', promptTokens: input, completionTokens: 0, cachedTokens: cached }]
}

/**
 * content_block_start：`tool_use` 块的**名字**只在这一帧给，后面的
 * `input_json_delta` 只有参数增量。所以这里必须产出 `tool-start`，否则
 * tool-start 永远丢失，客户端收到一堆没有名字的参数。
 *
 * `text` 块与 `thinking` 块不产出事件：它们的内容全在后续 delta 里，
 * 这里发空文本只会造成一个多余的空增量。
 */
function contentBlockStartEvents(payload: JsonObject): ChatEvent[] {
  const block = obj(payload.content_block)
  if (block === undefined || block.type !== 'tool_use') return []
  const index = num(payload.index) ?? 0
  const name = str(block.name)
  const id = str(block.id)
  return [{
    type: 'tool-start',
    index,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  }]
}

/** content_block_delta：四种 delta 各对应一种规范事件。 */
function contentDeltaEvents(payload: JsonObject): ChatEvent[] {
  const delta = obj(payload.delta)
  if (delta === undefined) return []
  const index = num(payload.index) ?? 0
  switch (delta.type) {
    case 'text_delta': {
      const text = str(delta.text)
      return text === undefined ? [] : [{ type: 'text', text }]
    }
    case 'thinking_delta':
    case 'signature_delta': {
      const text = str(delta.thinking)
      return text === undefined ? [] : [{ type: 'reasoning', text }]
    }
    case 'input_json_delta': {
      const partial = str(delta.partial_json)
      return partial === undefined || partial === '' ? [] : [{ type: 'tool-args', index, delta: partial }]
    }
    default:
      return []
  }
}

/** message_delta：finish_reason + 输出用量。 */
function messageDeltaEvents(payload: JsonObject): ChatEvent[] {
  const out: ChatEvent[] = []
  const delta = obj(payload.delta)
  const stop = delta?.stop_reason
  if (stop !== undefined && stop !== null) {
    out.push({ type: 'finish', reason: finishOf(stop === 'max_tokens' ? 'length' : stop) })
  }
  // usage 是可选的：`message_delta` 常只带 stop_reason，紧跟的
  // `message_stop` 才带最终 usage（也可能两帧都没有）。只有真的给了数字才
  // 产事件 —— 否则会在流尾多出一个全 0 的 usage，把前一个真 usage 盖掉。
  const usage = obj(payload.usage)
  if (usage !== undefined) {
    const prompt = num(usage.input_tokens)
    const completion = num(usage.output_tokens)
    if (prompt !== undefined || completion !== undefined) {
      out.push({
        type: 'usage',
        promptTokens: prompt ?? 0,
        completionTokens: completion ?? 0,
        cachedTokens: num(usage.cache_read_input_tokens) ?? 0,
      })
    }
  }
  return out
}

function finishToAnthropic(reason: FinishReason): string {
  switch (reason) {
    case 'length': return 'max_tokens'
    case 'tool-calls': return 'tool_use'
    case 'content-filter': return 'refusal'
    default: return 'end_turn'
  }
}
