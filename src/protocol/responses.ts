/**
 * OpenAI Responses 协议（Codex 用的是它）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 与 Chat Completions 的关键差异
 * ════════════════════════════════════════════════════════════════════
 *  请求  `input` 是**消息数组**（与 messages 同构）而不是 messages 本身
 *        `instructions` 替代 `system` 消息
 *        `max_output_tokens` 替代 `max_tokens`
 *        `tools` 项是扁平的 `{type:'function', name, parameters}`，
 *        没有 `function` 这一层包装
 *  响应  事件名带语义：`response.output_text.delta` / `response.function_call_arguments.delta`
 *        / `response.reasoning_summary_text.delta`，全部带 `sequence_number`
 *        收尾是 `response.completed`（带完整 response 对象），不是 finish_reason
 *
 * 丢弃（明确不做）：
 *   - `previous_response_id` / `store`：服务端会话态。我们的供应商契约是
 *     无状态的（`chatOnce` 一次一请求），转发过去只会拿到错误。
 *   - `reasoning.effort` 之外的 `reasoning.summary`：摘要粒度由上游定，
 *     我们只透传 reasoning 增量。
 *   - `include` / `text.format`（结构化输出）：跨协议没有对应物。
 */
import {
  type ChatEvent,
  type CodecContext,
  type JsonObject,
  type ProtocolCodec,
  arr,
  finishOf,
  num,
  obj,
  str,
} from './types.ts'
import { dataFrame, eventFrame } from './sse.ts'

export const responsesCodec: ProtocolCodec = {
  id: 'responses',

  /** Responses 请求 → Chat Completions 请求。 */
  toChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.input
    delete out.instructions
    delete out.tools
    delete out.max_output_tokens
    delete out.previous_response_id
    delete out.store
    delete out.include
    delete out.reasoning

    const messages: unknown[] = []
    const instructions = str(body.instructions)
    if (instructions !== undefined) messages.push({ role: 'system', content: instructions })
    for (const m of arr(body.input) ?? []) messages.push(inputItem(m))
    out.messages = messages
    if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens
    if (body.temperature !== undefined) out.temperature = body.temperature
    if (body.top_p !== undefined) out.top_p = body.top_p
    const tools = convertTools(body.tools)
    if (tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /** Chat Completions 请求 → Responses 请求。 */
  fromChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.messages
    delete out.tools
    delete out.stream
    delete out.max_tokens

    const input: unknown[] = []
    const instructions: string[] = []
    for (const m of arr(body.messages) ?? []) {
      const msg = obj(m)
      if (msg === undefined) continue
      const role = str(msg.role)
      if (role === 'system' || role === 'developer') {
        const t = contentText(msg.content)
        if (t !== '') instructions.push(t)
        continue
      }
      // tool 角色 → `function_call_output`：Chat 把工具结果放在 role:'tool'，
      // Responses 放在一个独立的 input 项里。丢了它上游会以为「工具从没被调用过」，
      // 于是重复发起同一个调用 —— 表现为无限工具循环。
      if (role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: str(msg.tool_call_id) ?? '',
          output: contentText(msg.content),
        })
        continue
      }
      const text = contentText(msg.content)
      // 文本永远是 message 项（空文本就不造一个空 message）
      if (text !== '') {
        input.push({
          type: 'message',
          role: role === 'assistant' ? 'assistant' : 'user',
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        })
      }
      // assistant 的 tool_calls → 每个一个 `function_call` 项（Responses 没有
      // 嵌套的 tool_calls，是平铺的独立项）。
      if (role === 'assistant') {
        for (const tc of arr(msg.tool_calls) ?? []) {
          const call = obj(tc)
          const fn = obj(call?.function)
          if (call === undefined || fn === undefined) continue
          const name = str(fn.name)
          if (name === undefined) continue
          input.push({
            type: 'function_call',
            call_id: str(call.id) ?? '',
            name,
            arguments: str(fn.arguments) ?? '{}',
          })
        }
      }
    }
    if (instructions.length > 0) out.instructions = instructions.join('\n\n')
    out.input = input
    if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens
    const tools = (body.tools as unknown[] | undefined)?.map(chatToolToResponses).filter((t) => t !== undefined)
    if (tools !== undefined && tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /* ---------------- 响应侧：Responses SSE → ChatEvent ---------------- */

  decodeFrame(frame, event) {
    let payload: JsonObject
    try {
      payload = JSON.parse(frame) as JsonObject
    } catch {
      return []
    }
    switch (event) {
      case 'response.output_text.delta': {
        const delta = str(payload.delta)
        return delta === undefined ? [] : [{ type: 'text', text: delta }]
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = str(payload.delta)
        return delta === undefined ? [] : [{ type: 'reasoning', text: delta }]
      }
      case 'response.function_call_arguments.delta': {
        const delta = str(payload.delta)
        if (delta === undefined || delta === '') return []
        // output_index 是「这一轮里第几个输出项」，与函数名无关；用 item_id 映射
        // 成连续 index 的活儿在 decode 层做不了（无状态），故这里直接用
        // output_index，由调方保证它与 tool-start 用的是同一套编号。
        return [{ type: 'tool-args', index: num(payload.output_index) ?? 0, delta }]
      }
      case 'response.output_item.added':
        return outputItemEvents(payload)
      case 'response.completed':
        return completedEvents(payload)
      case 'response.failed':
      case 'error': {
        const err = obj(obj(payload.response)?.error) ?? obj(payload.error)
        const message = str(err?.message) ?? str(payload.message) ?? 'upstream error'
        return [{ type: 'error', message }]
      }
      default:
        return []
    }
  },

  /* ---------------- 响应侧：ChatEvent → Responses SSE ---------------- */

  encodeFrame(event) {
    switch (event.type) {
      case 'text':
        return [
          eventFrame(
            'response.output_text.delta',
            JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: event.text }),
          ),
        ]
      case 'reasoning':
        return [
          eventFrame(
            'response.reasoning_summary_text.delta',
            JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: event.text }),
          ),
        ]
      case 'tool-start':
        return [
          eventFrame(
            'response.output_item.added',
            JSON.stringify({
              type: 'response.output_item.added',
              output_index: event.index,
              item: {
                type: 'function_call',
                id: event.id ?? `fc_${event.index}`,
                call_id: event.id ?? `call_${event.index}`,
                name: event.name ?? '',
                arguments: '',
              },
            }),
          ),
        ]
      case 'tool-args':
        return [
          eventFrame(
            'response.function_call_arguments.delta',
            JSON.stringify({
              type: 'response.function_call_arguments.delta',
              item_id: `fc_${event.index}`,
              output_index: event.index,
              delta: event.delta,
            }),
          ),
        ]
      case 'usage':
        return [] // usage 只在 response.completed 里给，见 endFrames
      case 'error':
        return [
          eventFrame(
            'error',
            JSON.stringify({ type: 'error', code: 'server_error', message: event.message }),
          ),
        ]
      case 'finish':
        return [] // 收尾在 response.completed，由 endFrames 负责
    }
  },

  startFrames() {
    return [
      eventFrame(
        'response.created',
        JSON.stringify({ type: 'response.created', response: { id: `resp_${Date.now().toString(36)}`, status: 'in_progress', output: [] } }),
      ),
    ]
  },

  /**
   * 流结束帧：`response.completed` 带一个完整的 response 对象。
   *
   * 用量与收尾原因都从 `ctx` 来（`StreamState.finishStream` 填），因为 Codex
   * 读的是 `response.completed` 里的 `status`/`usage`，而不是一个 finish_reason
   * 字段 —— 少了这一帧客户端会一直等流结束。
   */
  endFrames(ctx) {
    return [completedFrame(ctx.model, ctx.stream ? ctx.usage : undefined, ctx.finish)]
  },

  /**
   * 非流式响应体 → 规范事件。
   *
   * 非流式 Responses body 形状：`{output:[{type:'message',content:[{type:'output_text',text}]}
   * |{type:'function_call',name,arguments}], status, usage:{input_tokens,output_tokens}}`。
   * 与流式的 `response.output_item.added` / `response.completed` 共用同一组
   * item→事件 映射，见 `outputItemEvents`。
   */
  decodeJson(body) {
    const out: ChatEvent[] = []
    let index = 0
    let text = ''
    for (const item of arr(body.output) ?? []) {
      const it = obj(item)
      if (it === undefined) continue
      if (it.type === 'message') {
        for (const p of arr(it.content) ?? []) {
          const t = str(obj(p)?.text)
          if (t !== undefined) text += t
        }
        continue
      }
      if (it.type === 'function_call') {
        out.push({ type: 'tool-start', index, name: str(it.name) ?? '' })
        out.push({ type: 'tool-args', index, delta: str(it.arguments) ?? '' })
        index += 1
        continue
      }
      if (it.type === 'reasoning') {
        for (const s of arr(it.summary) ?? []) {
          const t = str(obj(s)?.text)
          if (t !== undefined) out.push({ type: 'reasoning', text: t })
        }
      }
    }
    if (text !== '') out.unshift({ type: 'text', text })
    const usage = obj(body.usage)
    if (usage !== undefined) {
      out.push({
        type: 'usage',
        promptTokens: num(usage.input_tokens) ?? 0,
        completionTokens: num(usage.output_tokens) ?? 0,
        cachedTokens: num(obj(usage.input_tokens_details)?.cached_tokens) ?? 0,
      })
    }
    const status = str(body.status)
    if (status === 'incomplete') out.push({ type: 'finish', reason: 'length' })
    else if (status === 'failed') out.push({ type: 'finish', reason: 'error' })
    else out.push({ type: 'finish', reason: 'stop' })
    return out
  },

  /** 规范事件 → 非流式 body。 */
  encodeJson(events, ctx) {
    const output: JsonObject[] = []
    let status = 'completed'
    let usage = { input: 0, output: 0 }
    for (const ev of events) {
      switch (ev.type) {
        case 'text':
          if (output.length > 0 && output[output.length - 1]?.type === 'message') {
            const c = (output[output.length - 1] as JsonObject).content as JsonObject[]
            if (c.length > 0 && c[c.length - 1]?.type === 'output_text') {
              ;(c[c.length - 1] as JsonObject).text += ev.text
              break
            }
            c.push({ type: 'output_text', text: ev.text })
            break
          }
          output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ev.text }] })
          break
        case 'reasoning': {
          const last = output[output.length - 1]
          if (last?.type === 'reasoning') {
            ;((last.summary as JsonObject[])[0] as JsonObject).text += ev.text
          } else {
            output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: ev.text }] })
          }
          break
        }
        case 'tool-start':
          output.push({ type: 'function_call', id: ev.id ?? `fc_${ev.index}`, call_id: ev.id ?? `call_${ev.index}`, name: ev.name ?? '', arguments: '' })
          break
        case 'tool-args': {
          const last = output[output.length - 1]
          if (last?.type === 'function_call') last.arguments += ev.delta
          break
        }
        case 'finish':
          if (ev.reason === 'length') status = 'incomplete'
          else if (ev.reason === 'error') status = 'failed'
          break
        case 'usage': usage = { input: ev.promptTokens, output: ev.completionTokens }; break
        case 'error': break
      }
    }
    return {
      id: `resp_${Date.now().toString(36)}`,
      object: 'response',
      status,
      model: ctx.model,
      output,
      usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output },
    }
  },
}

/* ------------------------------------------------------------------ */
/* 请求侧实现                                                         */
/* ------------------------------------------------------------------ */

/** Responses 的 input 项 → Chat message。 */
function inputItem(item: unknown): JsonObject | undefined {
  const it = obj(item)
  if (it === undefined) return undefined
  const type = str(it.type)
  // 消息形态
  if (type === 'message' || type === undefined) {
    const role = str(it.role) ?? 'user'
    const content = it.content
    if (typeof content === 'string') return { role, content }
    const text: string[] = []
    for (const p of arr(content) ?? []) {
      const part = obj(p)
      const t = part === undefined ? undefined : (str(part.text) ?? str(part.output_text))
      if (t !== undefined) text.push(t)
    }
    return { role, content: text.join('\n\n') }
  }
  // function_call 形态（模型上一轮发起的调用）
  if (type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: str(it.call_id) ?? str(it.id) ?? '',
        type: 'function',
        function: { name: str(it.name) ?? '', arguments: str(it.arguments) ?? '' },
      }],
    }
  }
  // function_call_output 形态（用户回传的工具结果）
  if (type === 'function_call_output') {
    return { role: 'tool', tool_call_id: str(it.call_id) ?? '', content: str(it.output) ?? '' }
  }
  return undefined
}

/** Chat 的 content（字符串或 parts）→ 纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of arr(content) ?? []) {
    const t = str(obj(p)?.text)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Chat tools → Responses tools（扁平形态）。 */
function convertTools(tools: unknown): JsonObject[] {
  const out: JsonObject[] = []
  for (const t of arr(tools) ?? []) {
    // Responses 的 tools 是扁平的；兼容被中间层包过一层的输入
    const tool = obj(t)
    const fn = tool === undefined ? undefined : (obj(tool.function) ?? tool)
    if (fn === undefined) continue
    const name = str(fn.name)
    if (name === undefined) continue
    out.push({
      type: 'function',
      // Chat 的具名工具是 `{type:'function', function:{...}}`，规范形态就是
      // Chat 形态 —— 所以这里必须**恢复包装**，否则跨协议往返时工具被丢掉
      // （Responses 上游能接受扁平形态，但 Router 只认 Chat 形态）。
      function: {
        name,
        description: str(fn.description) ?? '',
        parameters: obj(fn.parameters) ?? { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/**
 * Chat tool → Responses tool（`fromChat` 方向）。Responses 的 tools 是**扁平**的
 * `{ type:'function', name, description, parameters }`，而 Chat 的具名工具多包了
 * 一层 `function`。不解包的话 `tool.name` 恒为 undefined，工具被静默全部丢掉。
 */
function chatToolToResponses(t: unknown): JsonObject | undefined {
  const tool = obj(t)
  if (tool === undefined) return undefined
  const fn = obj(tool.function) ?? tool
  const name = str(fn.name)
  if (name === undefined) return undefined
  return {
    type: 'function',
    name,
    description: str(fn.description) ?? '',
    parameters: obj(fn.parameters) ?? { type: 'object', properties: {} },
  }
}

/* ------------------------------------------------------------------ */
/* 响应侧实现                                                         */
/* ------------------------------------------------------------------ */

/** `response.output_item.added`：函数调用项给出名字。 */
function outputItemEvents(payload: JsonObject): ChatEvent[] {
  const item = obj(payload.item)
  if (item === undefined || item.type !== 'function_call') return []
  return [{
    type: 'tool-start',
    index: num(payload.output_index) ?? 0,
    ...(str(item.id) === undefined ? {} : { id: str(item.id) }),
    name: str(item.name) ?? '',
  }]
}

/** `response.completed`：收尾 + 用量都在这帧。 */
function completedEvents(payload: JsonObject): ChatEvent[] {
  const response = obj(payload.response)
  const out: ChatEvent[] = []
  const usage = obj(response?.usage)
  if (usage !== undefined) {
    out.push({
      type: 'usage',
      promptTokens: num(usage.input_tokens) ?? 0,
      completionTokens: num(usage.output_tokens) ?? 0,
      cachedTokens: num(obj(usage.input_tokens_details)?.cached_tokens) ?? 0,
    })
  }
  const status = str(response?.status)
  if (status === 'failed') {
    out.push({ type: 'finish', reason: 'error' })
  } else if (status === 'incomplete') {
    // `incomplete_details.reason` 只可能是 `max_output_tokens` / `content_filter`。
    // 别看 `status` 本身：`incomplete` 不等于截断，content_filter 也是 incomplete。
    out.push({ type: 'finish', reason: finishOf(str(obj(response?.incomplete_details)?.reason)) })
  } else {
    // `status:'completed'` 本身**不带**收尾原因（Responses 没有 finish_reason
    // 字段），真原因是 output 里有没有 function_call：有就是 tool-calls。
    // 读不到 output 时按 stop —— 这是 Responses 语义上的「正常说完」。
    out.push({ type: 'finish', reason: outputHasToolCall(response?.output) ? 'tool-calls' : 'stop' })
  }
  return out
}

/** `response.output` 里有没有 `function_call` 项。 */
function outputHasToolCall(output: unknown): boolean {
  for (const item of Array.isArray(output) ? output : []) {
    if (obj(item)?.type === 'function_call') return true
  }
  return false
}

/**
 * 拼 `response.completed` 帧（收尾时由调用方带用量与收尾原因调）。
 *
 * `output` 里要写一条 `function_call` 占位项（当 finish 是 tool-calls 时）——
 * Responses 没有 finish_reason 字段，客户端（以及我们自己的 `completedEvents`）
 * 只能靠 `output` 里有没有 function_call 判断「这轮是调工具还是说完」。
 * 少了这条，工具轮在往返后会被认成普通结束。
 */
export function completedFrame(
  model: string,
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number },
  finish?: string,
): string {
  const response: JsonObject = {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    // 收尾原因映射到 Responses 的终态：长度截断 → incomplete，其余 completed。
    // 没有 `error` 分支：流内错误走 `error` 事件，不会走到收尾帧。
    status: finish === 'length' ? 'incomplete' : 'completed',
    model,
    output: finish === 'tool-calls'
      ? [{ type: 'function_call', id: `fc_${Date.now().toString(36)}`, call_id: `call_${Date.now().toString(36)}`, name: '', arguments: '' }]
      : [],
  }
  if (finish === 'length') response.incomplete_details = { reason: 'max_output_tokens' }
  if (usage !== undefined) {
    response.usage = {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
      ...(usage.cachedTokens !== undefined && usage.cachedTokens > 0
        ? { input_tokens_details: { cached_tokens: usage.cachedTokens } }
        : {}),
    }
  }
  return eventFrame('response.completed', JSON.stringify({ type: 'response.completed', response }))
}

/** Responses 的 usage 帧（若调用方要单独发）。 */
export function usageFrame(event: Extract<ChatEvent, { type: 'usage' }>): string {
  return dataFrame(JSON.stringify({ type: 'response.completed', response: { usage: event } }))
}
