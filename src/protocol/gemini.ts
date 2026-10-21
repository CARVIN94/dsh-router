/**
 * Google Gemini 协议（`generateContent` / `streamGenerateContent`）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 与其他三种的差异
 * ════════════════════════════════════════════════════════════════════
 *  1. **模型名在 URL 路径里**：`/v1beta/models/<model>:generateContent`，
 *     请求体里没有 `model` 字段。
 *  2. **角色名不同**：`user` / `model`（不是 assistant）。
 *  3. **内容是 parts**：`{parts:[{text}]}`，不是字符串。
 *  4. **工具调用是整块**：`functionCall` part 一次给全 `{name,args}`，
 *     没有增量形态 —— 故 decode 时拆成 tool-start + tool-args 一段。
 *  5. **鉴权走 query 参数 `?key=`** 或 `x-goog-api-key` 头（不是 Bearer）。
 *  6. **流式响应是 JSON 数组分片**（`[{...},{...}]`），不是 SSE ——
 *     `streamGenerateContent?alt=sse` 才给 SSE。我们只支持 `alt=sse`，
 *     非 SSE 形态明确不支持（见文件尾 `geminiStreamSse` 的说明）。
 *
 * 丢弃：`safetySettings` / `tools[].googleSearch` / `cachedContent` /
 *      `systemInstruction` 之外的 `generationConfig` 大部分字段（只留
 *      temperature / maxOutputTokens / stopSequences）。
 */
import {
  type ChatEvent,
  type CodecContext,
  type CodecSession,
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

export const geminiCodec: ProtocolCodec = {
  id: 'gemini',

  /** Gemini 请求 → Chat Completions 请求。 */
  toChat(body, ctx) {
    const out: JsonObject = {}
    const messages = geminiMessages(body)
    const sys = systemText(body.systemInstruction)
    if (sys !== '') messages.unshift({ role: 'system', content: sys })
    out.messages = messages
    const gen = obj(body.generationConfig)
    if (gen !== undefined) {
      if (num(gen.temperature) !== undefined) out.temperature = gen.temperature
      if (num(gen.maxOutputTokens) !== undefined) out.max_tokens = gen.maxOutputTokens
      if (arr(gen.stopSequences) !== undefined) out.stop = gen.stopSequences
    }
    const tools = convertTools(body.tools)
    if (tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    // model 由 URL 路径给出，调用方已填进 ctx；规范请求体里补上，供应商才知道调谁
    out.model = ctx.model
    return out
  },

  /** Chat Completions 请求 → Gemini 请求。 */
  fromChat(body, ctx) {
    const out: JsonObject = {}
    const systemParts: string[] = []
    const contents: JsonObject[] = []
    for (const m of arr(body.messages) ?? []) {
      const msg = obj(m)
      if (msg === undefined) continue
      const role = str(msg.role)
      if (role === 'system' || role === 'developer') {
        const t = contentText(msg.content)
        if (t !== '') systemParts.push(t)
        continue
      }
      if (role === 'assistant') {
        const parts: JsonObject[] = []
        const text = contentText(msg.content)
        if (text !== '') parts.push({ text })
        for (const tc of arr(msg.tool_calls) ?? []) {
          const fn = obj(obj(tc)?.function)
          parts.push({
            functionCall: {
              name: str(fn?.name) ?? '',
              args: parseArgs(str(fn?.arguments)),
            },
          })
        }
        contents.push({ role: 'model', parts })
        continue
      }
      if (role === 'tool') {
        // 工具结果 → functionResponse part，role 回到 user
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: str(msg.name) ?? '',
              response: { result: contentText(msg.content) },
            },
          }],
        })
        continue
      }
      contents.push({ role: 'user', parts: [{ text: contentText(msg.content) }] })
    }
    out.contents = contents
    if (systemParts.length > 0) {
      out.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
    }
    if (num(body.temperature) !== undefined || num(body.max_tokens) !== undefined) {
      out.generationConfig = {
        ...(num(body.temperature) === undefined ? {} : { temperature: body.temperature }),
        ...(num(body.max_tokens) === undefined ? {} : { maxOutputTokens: body.max_tokens }),
      }
    }
    if (arr(body.stop) !== undefined) {
      (out.generationConfig as JsonObject).stopSequences = body.stop
    }
    const tools = (body.tools as unknown[] | undefined)?.map(chatToolToGemini).filter((t) => t !== undefined)
    if (tools !== undefined && tools.length > 0) out.tools = [{ functionDeclarations: tools }]
    void ctx
    return out
  },

  /* ---------------- 响应侧：Gemini SSE → ChatEvent ---------------- */

  createSession() {
    return { state: newGeminiToolMap() }
  },

  decodeFrame(frame, _event, session) {
    let payload: JsonObject
    try {
      payload = JSON.parse(frame) as JsonObject
    } catch {
      return []
    }
    return geminiBodyEvents(payload, mapOf(session))
  },

  /* ---------------- 响应侧：ChatEvent → Gemini SSE ---------------- */

  encodeFrame(event, session) {
    const toolMap = mapOf(session)
    const chunk = (parts: JsonObject[], finish?: string): string[] => [
      dataFrame(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finish === undefined ? {} : { finishReason: finish }) }] })),
    ]
    switch (event.type) {
      case 'text':
        return chunk([{ text: event.text }])
      case 'reasoning':
        return chunk([{ text: event.text, thought: true }])
      case 'tool-start': {
        // **只登记名字，不发帧**。Gemini 的 functionCall 是「名字+参数整块」
        // 一个 part，没有「先声明、后补参数」的形态；在 tool-start 就发一帧
        // 空 args 会让客户端多认出一个 args={} 的工具调用，紧接着 tool-args
        // 再发一个同名带参数的 —— 客户端看到两次调用（2026-10-21 在 3080
        // 实测：`get_weather args={}` + `get_weather args={city:Beijing}`）。
        const name = event.name ?? ''
        if (name !== '') toolMap.remember(event.index, name)
        return []
      }
      case 'tool-args': {
        // **只累积，不发帧**。Gemini 的 `functionCall.args` 是整块对象，而上游
        // 会把一次调用拆成很多 `arguments` 增量帧。逐帧发会让客户端看到 N 次
        // 调用、前 N-1 次 args 还是空对象/半截 JSON（2026-10-21 在 3080 实测：
        // 一次调用发了 5 个 `args:{}`）。所以攒到 `endFrames` 里一次发出。
        toolMap.appendArgs(event.index, event.delta)
        return []
      }
      case 'usage':
        return [
          dataFrame(
            JSON.stringify({
              usageMetadata: {
                promptTokenCount: event.promptTokens,
                candidatesTokenCount: event.completionTokens,
                totalTokenCount: event.promptTokens + event.completionTokens,
                ...(event.cachedTokens > 0 ? { cachedContentTokenCount: event.cachedTokens } : {}),
              },
            }),
          ),
        ]
      case 'error':
        return [
          dataFrame(
            JSON.stringify({
              error: { code: 500, message: event.message, status: 'INTERNAL' },
            }),
          ),
        ]
      case 'finish':
        // **不发帧**，由 `endFrames` 在最后发。
        //
        // Gemini 的 `finishReason` 是「本轮说完了」的标记，客户端看到它就结束
        // 这一轮。而 `functionCall` 攒到流末才发 —— 若 finish 在这里先出去，
        // 客户端会在收到工具调用**之前**就判定结束，那次调用被丢掉
        // （2026-10-22 在 3080 实测：functionCall 排在 finishReason 之后）。
        return []
    }
  },

  startFrames: () => [],

  /**
   * 流末一次性发出**完整的** functionCall。
   *
   * 为什么集中在这里：Gemini 没有参数增量形态，一个调用必须「名字+完整参数」
   * 用一个 part 给出。上游（OpenAI 系）逐帧发参数增量，`tool-args` 只能攒；
   * 攒到流末参数才完整，此时才发得出合法的 `functionCall`。
   *
   * 半截 JSON（上游断流）**不发**：发出去客户端会拿坏参数执行工具，
   * 比少一次调用危险得多。
   */
  endFrames(ctx, session) {
    const toolMap = mapOf(session)
    const out: string[] = []
    for (const index of toolMap.pendingIndexes()) {
      const name = toolMap.nameOf(index)
      if (name === '') continue
      const args = toolMap.completeArgs(index)
      if (args === undefined) continue
      out.push(
        dataFrame(
          JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] }),
        ),
      )
    }
    // `finishReason` **最后**发 —— 客户端看到它就收尾这一轮，必须排在所有
    // 内容（含刚补发的 functionCall）之后。
    out.push(...chunkOf([], finishToGemini(ctx.finish ?? 'stop')))
    return out
  },

  /**
   * 非流式响应体 → 规范事件。
   *
   * Gemini 非流式 body 与流式一帧同形（`{candidates:[{content:{parts},finishReason}],
   * usageMetadata}`），所以直接复用 `decodeFrame` —— 这是四种协议里唯一
   * 「流与非流形状一致」的，没有第二份映射可写。
   */
  decodeJson(body) {
    return geminiBodyEvents(body, newGeminiToolMap())
  },

  /** 规范事件 → 非流式 body。 */
  encodeJson(events, ctx) {
    const toolMap = newGeminiToolMap()
    const parts: JsonObject[] = []
    let finish = 'STOP'
    let usage = { prompt: 0, output: 0, cached: 0 }
    for (const ev of events) {
      switch (ev.type) {
        case 'text': parts.push({ text: ev.text }); break
        case 'reasoning': parts.push({ text: ev.text, thought: true }); break
        case 'tool-start': {
          // 只登记名字，不产 part —— 与流式同理（Gemini 没有「先声明后补参」
          // 的形态，发占位 part 会让客户端看到两次调用）。
          const name = ev.name ?? ''
          if (name !== '') toolMap.remember(ev.index, name)
          break
        }
        case 'tool-args': {
          const name = toolMap.nameOf(ev.index)
          if (name !== '') parts.push({ functionCall: { name, args: parseArgs(ev.delta) } })
          break
        }
        case 'finish': finish = finishToGemini(ev.reason); break
        case 'usage': usage = { prompt: ev.promptTokens, output: ev.completionTokens, cached: ev.cachedTokens }; break
        case 'error': break
      }
    }
    void ctx
    return {
      candidates: [{ content: { role: 'model', parts }, finishReason: finish, index: 0 }],
      usageMetadata: {
        promptTokenCount: usage.prompt,
        candidatesTokenCount: usage.output,
        totalTokenCount: usage.prompt + usage.output,
        ...(usage.cached > 0 ? { cachedContentTokenCount: usage.cached } : {}),
      },
    }
  },
}

/* ------------------------------------------------------------------ */
/* 实现                                                               */
/* ------------------------------------------------------------------ */

/** 一帧 `candidates`。与 `encodeFrame` 里的闭包同形，供 `endFrames` 用。 */
function chunkOf(parts: JsonObject[], finish?: string): string[] {
  return [
    dataFrame(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, ...(finish === undefined ? {} : { finishReason: finish }) }],
      }),
    ),
  ]
}

/**
 * 工具名 ↔ index 的映射，**每个请求一份**。
 *
 * Gemini 没有 index 概念（工具调用靠 name 认），而规范事件用 index —— 所以
 * 跨帧必须有映射，而跨**请求**必须没有。模块级 Map 会串名（并发两条流各自
 * 的 `ls` 抢同一个 index，或者上一条流的映射残留到下一条），所以这里做成
 * 每个编解码会话一个实例，由 `StreamState` / `entry.ts` 在请求边界创建。
 *
 * 谁在用：`decodeFrameInto` / `encodeFrameWith` 拿到同一个 `GeminiToolMap`；
 * 单次调用（测试、非流式一次性转换）走 `geminiBodyEvents` 的默认实例。
 */
export interface GeminiToolMap {
  /** 工具名 → 规范 index（同名复用同一个 index）。 */
  indexOf(name: string): number
  /** 规范 index → 工具名（未知返回 ''）。 */
  nameOf(index: number): string
  /** 记下「规范 index → 工具名」（`tool-start` 带上游 index 时用）。 */
  remember(index: number, name: string): void
  /**
   * 把一段参数增量累到该 index 上，返回**截至目前**的完整 JSON。
   *
   * Gemini 的 `functionCall.args` 是整块对象，没有增量形态；而上游（OpenAI
   * 系）会把一次调用拆成很多 `arguments` 增量帧。逐帧发 `functionCall` 会让
   * 客户端看到 N 次调用、且前 N-1 次 args 是空对象或半截 JSON
   * （2026-10-21 在 3080 实测：5 个 `args:{}`）。所以只能攒。
   */
  appendArgs(index: number, delta: string): string
  /** 该 index 上是否有**完整可解析**的参数（流末判定用）。 */
  completeArgs(index: number): JsonObject | undefined
  /** 攒过参数的所有 index（流末按序发出）。 */
  pendingIndexes(): number[]
}

/** 新建一份空的工具名映射。 */
export function newGeminiToolMap(): GeminiToolMap {
  const byName = new Map<string, number>()
  const byIndex = new Map<number, string>()
  /** index → 已累积的参数片段（跨帧拼接后才是完整 JSON）。 */
  const argsByIndex = new Map<number, string>()
  let seq = 0
  return {
    indexOf(name) {
      const existing = byName.get(name)
      if (existing !== undefined) return existing
      const index = seq++
      byName.set(name, index)
      byIndex.set(index, name)
      return index
    },
    nameOf(index) {
      return byIndex.get(index) ?? ''
    },
    remember(index, name) {
      byIndex.set(index, name)
      if (!byName.has(name)) byName.set(name, index)
    },
    appendArgs(index, delta) {
      const next = (argsByIndex.get(index) ?? '') + delta
      argsByIndex.set(index, next)
      return next
    },
    completeArgs(index) {
      const raw = argsByIndex.get(index)
      if (raw === undefined || raw === '') return {}
      try {
        const v: unknown = JSON.parse(raw)
        return obj(v) ?? undefined
      } catch {
        return undefined // 半截 JSON：还没攒够
      }
    },
    pendingIndexes() {
      return [...argsByIndex.keys()].sort((a, b) => a - b)
    },
  }
}

/**
 * 取本次调用的工具名映射：有会话用会话的，没有就临时建一份。
 *
 * 「没有会话」= 单帧独立转换（测试、非流式一次性）。结果与无状态等价 ——
 * 名字在自己的调用里总能拿到，只是不跨帧复用。
 */
function mapOf(session: CodecSession | undefined): GeminiToolMap {
  const st = session?.state
  return st instanceof Object && 'indexOf' in st ? (st as GeminiToolMap) : newGeminiToolMap()
}

/**
 * 一个 Gemini 响应体（流式一帧或非流式 body，两者同形）→ 规范事件。
 *
 * Gemini 是四种协议里唯一「流与非流形状一致」的，所以只有这一份映射。
 */
function geminiBodyEvents(payload: JsonObject, tools: GeminiToolMap): ChatEvent[] {
  const out: ChatEvent[] = []
  const candidate = obj(arr(payload.candidates)?.[0])
  if (candidate !== undefined) {
    const finish = candidate.finishReason
    if (finish !== undefined && finish !== null) {
      out.push({ type: 'finish', reason: finishOf(finish) })
    }
    for (const p of arr(obj(candidate.content)?.parts) ?? []) {
      const part = obj(p)
      if (part === undefined) continue
      const text = str(part.text)
      if (text !== undefined) {
        // thought: true 的 part 是推理内容
        if (part.thought === true) out.push({ type: 'reasoning', text })
        else out.push({ type: 'text', text })
        continue
      }
      const fc = obj(part.functionCall)
      if (fc !== undefined) {
        const name = str(fc.name) ?? ''
        // 没名字的 functionCall 不能变成 tool-start：那会凭空造一个叫 "" 的
        // 工具，客户端会把它当成第二个工具调用。
        if (name === '') continue
        const index = tools.indexOf(name)
        out.push({ type: 'tool-start', index, name })
        out.push({ type: 'tool-args', index, delta: JSON.stringify(fc.args ?? {}) })
      }
    }
  }
  const usage = obj(payload.usageMetadata)
  if (usage !== undefined) {
    out.push({
      type: 'usage',
      promptTokens: num(usage.promptTokenCount) ?? 0,
      completionTokens: num(usage.candidatesTokenCount) ?? 0,
      cachedTokens: num(usage.cachedContentTokenCount) ?? 0,
    })
  }
  return out
}

/** Gemini 的 systemInstruction → 纯文本。 */
function systemText(sys: unknown): string {
  const parts: string[] = []
  for (const p of arr(obj(sys)?.parts) ?? []) {
    const t = str(obj(p)?.text)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Gemini contents → Chat messages。 */
function geminiMessages(body: JsonObject): unknown[] {
  const out: unknown[] = []
  for (const c of arr(body.contents) ?? []) {
    const item = obj(c)
    if (item === undefined) continue
    const role = str(item.role) === 'model' ? 'assistant' : 'user'
    const text: string[] = []
    const toolCalls: JsonObject[] = []
    for (const p of arr(item.parts) ?? []) {
      const part = obj(p)
      if (part === undefined) continue
      const t = str(part.text)
      if (t !== undefined) { text.push(t); continue }
      const fc = obj(part.functionCall)
      if (fc !== undefined) {
        toolCalls.push({
          id: `call_${str(fc.name) ?? ''}`,
          type: 'function',
          function: { name: str(fc.name) ?? '', arguments: JSON.stringify(fc.args ?? {}) },
        })
        continue
      }
      const fr = obj(part.functionResponse)
      if (fr !== undefined) {
        out.push({ role: 'tool', tool_call_id: `call_${str(fr.name) ?? ''}`, content: JSON.stringify(obj(fr.response)?.result ?? {}) })
      }
    }
    if (role === 'assistant') {
      const msg: JsonObject = { role: 'assistant', content: text.join('\n\n') }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      out.push(msg)
    } else if (text.length > 0) {
      out.push({ role: 'user', content: text.join('\n\n') })
    }
  }
  return out
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

function parseArgs(s: string | undefined): JsonObject {
  if (s === undefined || s === '') return {}
  try {
    const v: unknown = JSON.parse(s)
    return obj(v) ?? {}
  } catch {
    return {}
  }
}

/** Chat tools → Gemini functionDeclarations。 */
function chatToolToGemini(t: unknown): JsonObject | undefined {
  const fn = obj(obj(t)?.function)
  const name = fn === undefined ? undefined : str(fn.name)
  if (fn === undefined || name === undefined) return undefined
  return {
    name,
    description: str(fn.description) ?? '',
    parameters: obj(fn.parameters) ?? { type: 'object', properties: {} },
  }
}

/** Gemini tools → Chat tools。 */
function convertTools(tools: unknown): JsonObject[] {
  const out: JsonObject[] = []
  for (const t of arr(tools) ?? []) {
    for (const d of arr(obj(t)?.functionDeclarations) ?? []) {
      const decl = obj(d)
      if (decl === undefined) continue
      const name = str(decl.name)
      if (name === undefined) continue
      out.push({
        type: 'function',
        function: {
          name,
          description: str(decl.description) ?? '',
          parameters: obj(decl.parameters) ?? { type: 'object', properties: {} },
        },
      })
    }
  }
  return out
}

function finishToGemini(reason: FinishReason): string {
  switch (reason) {
    case 'length': return 'MAX_TOKENS'
    case 'tool-calls': return 'STOP'
    case 'content-filter': return 'SAFETY'
    case 'error': return 'OTHER'
    default: return 'STOP'
  }
}
