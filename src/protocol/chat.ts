/**
 * OpenAI Chat Completions 协议 —— **规范形态本身**，所以编解码是恒等变换。
 *
 * 这个文件承担两件别处不做的事：
 *
 * 1. **请求侧恒等**：`toChat`/`fromChat` 原样返回。供应商契约
 *    （`suppliers/contract.ts` 的 `chatOnce`）吃的就是 Chat Completions 请求体，
 *    多一层拷贝只会让「哪一层改的」变难查。
 *
 * 2. **响应侧的规范事件翻译**：OpenAI SSE → `ChatEvent`，以及反向。这是**所有
 *    协议共用的脊柱** —— Anthropic/Gemini 的 `decodeFrame` 拿到自己的帧后，
 *    也要靠这里的逻辑把内容映射成同一组事件，才能让「Anthropic 客户端问、
 *    Gemini 供应商答」这条路只有两个模块参与，而不是 12 条路径。
 *
 * ⚠️ 这里的映射规则与 `llm/adapter.ts` 的 `translateSse` 是**同一套语义的两种
 *    落点**：那边翻译成 DSH 的 `StreamChunk`（给宿主 agent loop 用），这边翻译
 *    成 `ChatEvent`（给协议矩阵用）。两处都留着，因为消费方不同、且
 *    `translateSse` 里那些踩过坑的处理（残缺 tool_call 收尾、空串 name 剥除）
 *    只对 DSH 有意义；但**改任何一处规则都必须看另一处**，否则同一个上游在
 *    两个入口表现不一致。
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
import { dataFrame } from './sse.ts'

/* ------------------------------------------------------------------ */
/* 请求侧：恒等                                                       */
/* ------------------------------------------------------------------ */

export const chatCodec: ProtocolCodec = {
  id: 'chat',
  toChat: (body) => body,
  fromChat: (body) => body,

  /* ---------------- 响应侧：OpenAI SSE → ChatEvent ---------------- */

  decodeFrame(frame) {
    let chunk: JsonObject
    try {
      chunk = JSON.parse(frame) as JsonObject
    } catch {
      return [] // 坏帧跳过（半截 JSON 是上游常态）
    }
    return chatBodyEvents(chunk)
  },

  /**
   * 非流式响应体 → 规范事件。
   *
   * 复用同一个 `chatBodyEvents`：一个非流式 body 就是一帧（内容在
   * `choices[0].message` 里、`finish_reason` 已给、`usage` 在外层）。单独实现
   * 一份只会让「流式与非流式行为不一致」有地方可长。
   */
  decodeJson(body) {
    return chatBodyEvents(body)
  },

  /* ---------------- 响应侧：ChatEvent → OpenAI SSE ---------------- */

  encodeFrame(event) {
    switch (event.type) {
      case 'text':
        return [dataFrame(JSON.stringify(choiceDelta({ content: event.text })))]
      case 'reasoning':
        return [dataFrame(JSON.stringify(choiceDelta({ reasoning_content: event.text })))]
      case 'tool-start':
        return [
          dataFrame(
            JSON.stringify(
              choiceDelta({
                tool_calls: [{
                  index: event.index,
                  ...(event.id === undefined ? {} : { id: event.id }),
                  type: 'function',
                  function: { name: event.name ?? '', arguments: '' },
                }],
              }),
            ),
          ),
        ]
      case 'tool-args':
        return [
          dataFrame(
            JSON.stringify(
              choiceDelta({
                tool_calls: [{ index: event.index, function: { arguments: event.delta } }],
              }),
            ),
          ),
        ]
      case 'usage':
        // 只在有非零值时发：全 0 的 usage 帧会让客户端把「上游没给」当成「给了 0」
        if (event.promptTokens === 0 && event.completionTokens === 0 && event.cachedTokens === 0) return []
        return [
          dataFrame(
            JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: event.promptTokens,
                completion_tokens: event.completionTokens,
                total_tokens: event.promptTokens + event.completionTokens,
              },
            }),
          ),
        ]
      case 'error':
        return [dataFrame(JSON.stringify({ error: { message: event.message, type: 'api_error' } }))]
      case 'finish':
        return [
          dataFrame(JSON.stringify(choiceDelta({}, finishToOpenAi(event.reason)))),
          'data: [DONE]\n\n',
        ]
    }
  },

  startFrames: () => [],
  endFrames: () => [],

  /** 规范事件 → 非流式 body。 */
  encodeJson(events, ctx) {
    let content = ''
    let reasoning = ''
    let finish: FinishReason = 'stop'
    let usage: Extract<ChatEvent, { type: 'usage' }> | undefined
    const calls = new Map<number, { id?: string; name: string; args: string }>()
    for (const ev of events) {
      switch (ev.type) {
        case 'text': content += ev.text; break
        case 'reasoning': reasoning += ev.text; break
        case 'tool-start':
          calls.set(ev.index, { ...(ev.id === undefined ? {} : { id: ev.id }), name: ev.name ?? '', args: '' })
          break
        case 'tool-args': {
          const c = calls.get(ev.index) ?? { name: '', args: '' }
          c.args += ev.delta
          calls.set(ev.index, c)
          break
        }
        case 'finish': finish = ev.reason; break
        case 'usage': usage = ev; break
        case 'error': break
      }
    }
    const message: JsonObject = { role: 'assistant', content }
    if (reasoning !== '') message.reasoning_content = reasoning
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name !== '')
      .map(([i, c]) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args } }))
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    const body: JsonObject = {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [{ index: 0, message, finish_reason: finishToOpenAi(finish) }],
    }
    if (usage !== undefined) {
      body.usage = {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      }
    }
    return body
  },
}

/** OpenAI 的一帧 `choices[0].delta`。 */
function choiceDelta(delta: JsonObject, finish?: string): JsonObject {
  return {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

/**
 * 一个 OpenAI 响应体（流式帧或非流式 body，两者形状一致）→ 规范事件。
 *
 * 流式与非流式共用：非流式 body 就是「一帧」（`choices[0].message` 带全量
 * 内容、`finish_reason` 已给、`usage` 在外层）。分开写两份只会让两边行为
 * 漂移 —— 而漂移的表现是「同一个上游在流式下工具名对、非流式下为空」。
 */
function chatBodyEvents(chunk: JsonObject): ChatEvent[] {
  const out: ChatEvent[] = []
  const usage = decodeUsage(chunk)
  if (usage !== undefined) out.push(usage)
  const err = obj(chunk.error)
  if (err !== undefined) {
    out.push({ type: 'error', message: str(err.message) ?? 'upstream error' })
    return out
  }
  const ch = obj(arr(chunk.choices)?.[0])
  if (ch === undefined) return out
  // 内容在 delta（流式）或 message（非流式）里
  const delta = obj(ch.delta) ?? obj(ch.message)
  if (delta !== undefined) {
    const text = str(delta.content)
    if (text !== undefined) out.push({ type: 'text', text })
    // reasoning 有两种拼写：reasoning_content（国产系）/ reasoning（OpenAI o 系）
    const reasoning = str(delta.reasoning_content) ?? str(obj(delta.reasoning)?.text)
    if (reasoning !== undefined) out.push({ type: 'reasoning', text: reasoning })
    for (const ev of decodeToolCalls(delta.tool_calls)) out.push(ev)
  }
  const finish = ch.finish_reason
  if (finish !== undefined && finish !== null) {
    out.push({ type: 'finish', reason: finishOf(finish) })
  }
  return out
}

function finishToOpenAi(reason: FinishReason): string {
  switch (reason) {
    case 'length': return 'length'
    case 'tool-calls': return 'tool_calls'
    case 'content-filter': return 'content_filter'
    case 'error': return 'stop'
    default: return 'stop'
  }
}

/** OpenAI SSE 帧 → 工具调用增量。 */
function decodeToolCalls(v: unknown): ChatEvent[] {
  const list = arr(v)
  if (list === undefined) return []
  const out: ChatEvent[] = []
  for (const item of list) {
    const tc = obj(item)
    if (tc === undefined) continue
    const index = num(tc.index) ?? 0
    const fn = obj(tc.function)
    const name = fn === undefined ? undefined : str(fn.name)
    const id = str(tc.id)
    // 只在**有新信息**时发 tool-start：后续增量帧的名字是空串（或 null），
    // 照发会把已建立的名字冲掉（`llm/adapter.ts` 里同一个坑）
    if (name !== undefined || id !== undefined) {
      out.push({ type: 'tool-start', index, ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) })
    }
    const args = fn === undefined ? undefined : str(fn.arguments)
    if (args !== undefined && args !== '') out.push({ type: 'tool-args', index, delta: args })
  }
  return out
}

/**
 * 从一帧 OpenAI 响应里取用量。
 *
 * 口径与 `router/usage-tokens.ts` 的 `normalizeUsage` 一致：`prompt_tokens`
 * **含**缓存（OpenAI 系如此），`cachedTokens` 是它的子集。
 */
function decodeUsage(chunk: JsonObject): ChatEvent | undefined {
  const u = obj(chunk.usage)
  if (u === undefined) return undefined
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0
  const completion = num(u.completion_tokens) ?? num(u.output_tokens) ?? 0
  const cached = num(u.cached_tokens) ?? num(obj(u.prompt_tokens_details)?.cached_tokens) ?? 0
  return { type: 'usage', promptTokens: prompt, completionTokens: completion, cachedTokens: cached }
}

/** 收尾原因 → 规范形态（在各协议模块里共用，从这再导出省一次 import）。 */
export { finishOf }
